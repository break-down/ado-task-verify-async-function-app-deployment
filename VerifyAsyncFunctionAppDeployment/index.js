"use strict";

const https = require("https");
const { URL, URLSearchParams } = require("url");
const tl = require("azure-pipelines-task-lib/task");

const DEFAULT_ARM_RESOURCE = "https://management.azure.com/";
const DEFAULT_AUTHORITY_URL = "https://login.microsoftonline.com/";
const DEFAULT_ARM_API_VERSION = "2025-05-01";
const DEPLOYMENT_FRESHNESS_WINDOW_MS = 10 * 60 * 1000;
const MAX_WARNING_COUNT = 5;
const SETUP_RETRY_ATTEMPTS = 3;
const POLLING_RETRY_ATTEMPTS = 2;
const RETRY_BACKOFF_BASE_MS = 1000;
const RETRY_BACKOFF_MAX_MS = 5000;
const TRANSIENT_NETWORK_ERROR_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"]);
const SUCCESS_TEXT_STATES = new Set(["success", "succeeded", "complete", "completed"]);
const FAILURE_TEXT_STATES = new Set(["failed", "failure", "error"]);
const ACTIVE_TEXT_STATES = new Set([
  "accepted",
  "building",
  "created",
  "deploying",
  "inprogress",
  "in_progress",
  "pending",
  "queued",
  "received",
  "running",
  "started",
  "starting"
]);

const KUDU_STATUS = {
  pending: 0,
  building: 1,
  deploying: 2,
  failed: 3,
  success: 4
};

function buildEndpoints(options) {
  const armResource = normalizeBaseUrl(options.armResource || DEFAULT_ARM_RESOURCE);
  const subscriptionId = encodeURIComponent(options.subscriptionId);
  const functionAppName = encodeURIComponent(options.functionAppName);
  const apiVersion = encodeURIComponent(options.apiVersion || DEFAULT_ARM_API_VERSION);
  const normalizedScmUri = options.scmUri ? String(options.scmUri).replace(/\/+$/, "") : "";
  const siteResourcePath = options.siteResourceId ? trimLeadingSlash(options.siteResourceId) : "";

  return {
    listSites: `${armResource}subscriptions/${subscriptionId}/providers/Microsoft.Web/sites?api-version=${apiVersion}`,
    publishingCredentials: `${armResource}${siteResourcePath}/config/publishingcredentials/list?api-version=${apiVersion}`,
    deployments: `${normalizedScmUri}/api/deployments`,
    deployment: (deploymentId) => `${normalizedScmUri}/api/deployments/${encodeURIComponent(deploymentId)}`,
    deploymentLog: (deploymentId) => `${normalizedScmUri}/api/deployments/${encodeURIComponent(deploymentId)}/log`,
    deploymentLogDetails: (deploymentId, logId) =>
      `${normalizedScmUri}/api/deployments/${encodeURIComponent(deploymentId)}/log/${encodeURIComponent(logId)}`
  };
}

async function run() {
  const startedAt = Date.now();
  let finalStatus = "Failed";
  let finalError = "";
  let deploymentId = "";

  try {
    const inputs = readInputs();
    const authContext = await createAuthContext(inputs.connectedServiceNameARM);
    const functionAppResource = await resolveFunctionAppResource(authContext, inputs);
    const armEndpoints = buildEndpoints({
      armResource: authContext.armResource,
      subscriptionId: authContext.subscriptionId,
      functionAppName: inputs.functionAppName,
      siteResourceId: functionAppResource.resourceId
    });

    tl.debug(`Using subscription ${authContext.subscriptionId}`);
    tl.debug(`Resolving SCM endpoint for ${inputs.functionAppName} in resource group ${functionAppResource.resourceGroupName}`);

    const publishingCredentials = await requestJson({
      method: "POST",
      url: armEndpoints.publishingCredentials,
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`
      },
      retryClass: "fatal"
    });

    const scmAuth = createScmAuth(publishingCredentials);
    const endpoints = buildEndpoints({
      armResource: authContext.armResource,
      subscriptionId: authContext.subscriptionId,
      functionAppName: inputs.functionAppName,
      siteResourceId: functionAppResource.resourceId,
      scmUri: scmAuth.scmUri
    });

    tl.debug(`Polling deployment status from ${redactCredentials(endpoints.deployments)}`);

    const result = await pollDeploymentStatus({
      endpoints,
      scmAuth,
      pollingIntervalMs: inputs.pollingIntervalSeconds * 1000,
      timeoutMs: inputs.timeoutMinutes * 60 * 1000,
      startedAt,
      verboseFailureLogs: inputs.verboseFailureLogs
    });

    finalStatus = result.status;
    finalError = result.errorMessage || "";
    deploymentId = result.deploymentId || "";

    setOutputs({
      deploymentStatus: finalStatus,
      errorMessage: finalError,
      deploymentDuration: secondsSince(startedAt),
      deploymentId
    });

    if (finalStatus === "Succeeded") {
      tl.setResult(tl.TaskResult.Succeeded, `Deployment ${deploymentId || "unknown"} succeeded in ${secondsSince(startedAt)} seconds.`);
      return;
    }

    tl.setResult(tl.TaskResult.Failed, finalError || `Deployment ${deploymentId || "unknown"} ended with status ${finalStatus}.`);
  } catch (error) {
    finalError = getErrorMessage(error);
    setOutputs({
      deploymentStatus: finalStatus,
      errorMessage: finalError,
      deploymentDuration: secondsSince(startedAt),
      deploymentId
    });
    tl.setResult(tl.TaskResult.Failed, finalError);
  }
}

function readInputs() {
  const connectedServiceNameARM = tl.getInput("connectedServiceNameARM", true);
  const functionAppName = tl.getInput("functionAppName", true);
  const pollingIntervalSeconds = normalizeIntegerInput("pollingIntervalSeconds", 30, 5, 300);
  const timeoutMinutes = normalizeIntegerInput("timeoutMinutes", 5, 1, 60);
  const verboseFailureLogs = tl.getBoolInput("verboseFailureLogs", false);

  return {
    connectedServiceNameARM,
    functionAppName,
    pollingIntervalSeconds,
    timeoutMinutes,
    verboseFailureLogs
  };
}

async function resolveFunctionAppResource(authContext, inputs) {
  tl.debug(`Searching subscription for Function App ${inputs.functionAppName}.`);

  const endpoints = buildEndpoints({
    armResource: authContext.armResource,
    subscriptionId: authContext.subscriptionId,
    functionAppName: inputs.functionAppName
  });

  const sites = await requestPagedArmCollection(endpoints.listSites, authContext.accessToken);
  const matches = sites.filter((site) => {
    const nameMatches = site && typeof site.name === "string" && site.name.toLowerCase() === inputs.functionAppName.toLowerCase();
    const kind = site && typeof site.kind === "string" ? site.kind.toLowerCase() : "";
    return nameMatches && kind.includes("functionapp");
  });

  if (matches.length === 0) {
    throw new Error(
      `Unable to find Function App '${inputs.functionAppName}' in subscription ${authContext.subscriptionId}. ` +
      "Select the app from the dropdown and confirm the service connection can read Function Apps in this subscription."
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `Found multiple Function App resources named '${inputs.functionAppName}' in subscription ${authContext.subscriptionId}. ` +
      "Function App names are expected to be unique in a subscription; select the intended app from the dropdown or rename one of the duplicates."
    );
  }

  const resourceId = matches[0].id;
  const resourceGroupName = getResourceGroupNameFromResourceId(resourceId);

  if (!resourceId || !resourceGroupName) {
    throw new Error(`Function App '${inputs.functionAppName}' was found, but Azure did not return a usable resource ID.`);
  }

  tl.debug(`Resolved Function App ${inputs.functionAppName} to resource group ${resourceGroupName}.`);

  return {
    resourceGroupName,
    resourceId
  };
}

function normalizeIntegerInput(name, defaultValue, minValue, maxValue) {
  const rawValue = tl.getInput(name, false);
  const value = rawValue ? Number.parseInt(rawValue, 10) : defaultValue;

  if (!Number.isInteger(value) || value < minValue || value > maxValue) {
    throw new Error(`${name} must be an integer between ${minValue} and ${maxValue}.`);
  }

  return value;
}

async function createAuthContext(endpointId) {
  const subscriptionId =
    tl.getEndpointDataParameter(endpointId, "subscriptionid", true) ||
    tl.getEndpointDataParameter(endpointId, "subscriptionId", true);
  const armResource = normalizeArmResource(
    tl.getEndpointDataParameter(endpointId, "resourceManagerEndpointUrl", true),
    tl.getEndpointDataParameter(endpointId, "activeDirectoryServiceEndpointResourceId", true)
  );
  const authorityUrl = normalizeBaseUrl(
    tl.getEndpointDataParameter(endpointId, "environmentAuthorityUrl", true) ||
    tl.getEndpointDataParameter(endpointId, "activeDirectoryAuthority", true) ||
    DEFAULT_AUTHORITY_URL
  );
  const tenantId = getEndpointAuthParameter(endpointId, "tenantid", false);
  const clientId = getEndpointAuthParameter(endpointId, "serviceprincipalid", false);
  const clientSecret = getEndpointAuthParameter(endpointId, "serviceprincipalkey", true);
  const endpointScheme = (tl.getEndpointAuthorizationScheme(endpointId, true) || "").toLowerCase();

  if (!subscriptionId) {
    throw new Error("Unable to resolve subscription ID from the Azure Resource Manager service connection.");
  }

  if (!tenantId || !clientId) {
    throw new Error("Unable to resolve tenant ID or service principal ID from the Azure Resource Manager service connection.");
  }

  const accessToken = endpointScheme === "workloadidentityfederation" || !clientSecret
    ? await acquireTokenWithFederatedCredential(endpointId, tenantId, clientId, authorityUrl, `${armResource}.default`)
    : await acquireTokenWithClientSecret(tenantId, clientId, clientSecret, authorityUrl, `${armResource}.default`);

  return {
    armResource,
    accessToken,
    subscriptionId
  };
}

function getEndpointAuthParameter(endpointId, key, optional) {
  try {
    return tl.getEndpointAuthorizationParameter(endpointId, key, optional);
  } catch (error) {
    if (optional) {
      return "";
    }

    throw error;
  }
}

async function acquireTokenWithClientSecret(tenantId, clientId, clientSecret, authorityUrl, scope) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope
  }).toString();

  const response = await requestJson({
    method: "POST",
    url: `${authorityUrl}${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    retryClass: "fatal"
  });

  if (!response.access_token) {
    throw new Error("Microsoft Entra token response did not include an access token.");
  }

  return response.access_token;
}

async function acquireTokenWithFederatedCredential(endpointId, tenantId, clientId, authorityUrl, scope) {
  const assertion = await resolveFederatedAssertion(endpointId);
  const body = new URLSearchParams({
    client_id: clientId,
    client_assertion: assertion,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    grant_type: "client_credentials",
    scope
  }).toString();

  const response = await requestJson({
    method: "POST",
    url: `${authorityUrl}${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    retryClass: "fatal"
  });

  if (!response.access_token) {
    throw new Error("Microsoft Entra workload identity token response did not include an access token.");
  }

  return response.access_token;
}

async function resolveFederatedAssertion(endpointId) {
  const endpointAssertion =
    getEndpointAuthParameter(endpointId, "idToken", true) ||
    getEndpointAuthParameter(endpointId, "oidctoken", true) ||
    getEndpointAuthParameter(endpointId, "workloadidentityfederationtoken", true);

  if (endpointAssertion) {
    return endpointAssertion;
  }

  const oidcRequestUri = process.env.SYSTEM_OIDCREQUESTURI;
  const systemAccessToken = process.env.SYSTEM_ACCESSTOKEN;

  if (!oidcRequestUri || !systemAccessToken) {
    throw new Error(
      "The Azure service connection uses workload identity federation, but no OIDC assertion was available. " +
      "Enable 'Allow scripts to access the OAuth token' for classic pipelines or use a service principal secret connection."
    );
  }

  const response = await requestJson({
    method: "GET",
    url: oidcRequestUri,
    headers: {
      Authorization: `Bearer ${systemAccessToken}`
    },
    retryClass: "fatal"
  });

  const assertion = response.oidcToken || response.id_token || response.idToken || response.token;
  if (!assertion) {
    throw new Error("Azure DevOps OIDC token response did not include an id token.");
  }

  return assertion;
}

function createScmAuth(publishingCredentials) {
  const properties = publishingCredentials && publishingCredentials.properties ? publishingCredentials.properties : {};
  const scmUri = properties.scmUri;
  const publishingUserName = properties.publishingUserName;
  const publishingPassword = properties.publishingPassword;

  if (!scmUri) {
    throw new Error("App Service publishing credentials response did not include properties.scmUri.");
  }

  const parsed = new URL(scmUri);
  const userName = decodeURIComponent(parsed.username || publishingUserName || "");
  const password = decodeURIComponent(parsed.password || publishingPassword || "");
  parsed.username = "";
  parsed.password = "";

  if (!userName || !password) {
    throw new Error("App Service publishing credentials response did not include SCM credentials.");
  }

  return {
    scmUri: parsed.toString().replace(/\/+$/, ""),
    authorizationHeader: `Basic ${Buffer.from(`${userName}:${password}`, "utf8").toString("base64")}`
  };
}

async function pollDeploymentStatus(options) {
  const timeoutAt = options.startedAt + options.timeoutMs;
  let attempt = 0;
  let warningCount = 0;
  let observedDeploymentId = "";
  let lastState = "Unknown";
  let lastError = "";

  while (Date.now() < timeoutAt) {
    attempt += 1;
    const elapsedSeconds = secondsSince(options.startedAt);
    tl.debug(`Deployment verification attempt ${attempt}; elapsed ${elapsedSeconds}s.`);

    try {
      const deployment = await getLatestDeployment(options.endpoints, options.scmAuth, options.startedAt - DEPLOYMENT_FRESHNESS_WINDOW_MS);
      const classification = classifyDeployment(deployment);
      observedDeploymentId = deployment.id || observedDeploymentId;
      lastState = classification.displayStatus;
      lastError = classification.errorMessage || lastError;

      tl.debug(`Observed deployment ${observedDeploymentId || "unknown"} state ${lastState}.`);
      console.log(`Deployment verification: attempt=${attempt}; elapsedSeconds=${elapsedSeconds}; deploymentId=${observedDeploymentId || "unknown"}; status=${lastState}`);

      if (classification.kind === "success") {
        return {
          status: "Succeeded",
          errorMessage: "",
          deploymentId: observedDeploymentId
        };
      }

      if (classification.kind === "failed") {
        const resolvedError = await resolveDeploymentError(options.endpoints, options.scmAuth, deployment, classification.errorMessage);
        const errorMessage = resolvedError.errorMessage;
        if (options.verboseFailureLogs) {
          writeVerboseFailureLogs({
            deploymentId: observedDeploymentId,
            status: lastState,
            errorMessage,
            details: resolvedError.verboseDetails
          });
        }
        return {
          status: "Failed",
          errorMessage,
          deploymentId: observedDeploymentId
        };
      }
    } catch (error) {
      const transient = isTransientPollingError(error);
      if (!transient) {
        throw error;
      }

      lastError = getErrorMessage(error);
      if (warningCount < MAX_WARNING_COUNT) {
        warningCount += 1;
        tl.warning(`Deployment status is not available yet: ${lastError}`);
      } else {
        tl.debug(`Suppressed transient deployment polling warning: ${lastError}`);
      }
    }

    await delay(Math.min(options.pollingIntervalMs, Math.max(0, timeoutAt - Date.now())));
  }

  const timeoutMessage =
    `Deployment verification timed out after ${Math.round(options.timeoutMs / 60000)} minute(s). ` +
    `Last observed status: ${lastState}. ${lastError ? `Last error: ${lastError}` : ""}`.trim();

  return {
    status: "Timed Out",
    errorMessage: timeoutMessage,
    deploymentId: observedDeploymentId
  };
}

async function getLatestDeployment(endpoints, scmAuth, earliestAcceptedTimestamp) {
  const deployments = await requestJson({
    method: "GET",
    url: endpoints.deployments,
    headers: {
      Authorization: scmAuth.authorizationHeader
    },
    retryClass: "poll"
  });

  if (!Array.isArray(deployments) || deployments.length === 0) {
    const error = new Error("Deployment Center has not returned any deployment records yet.");
    error.transient = true;
    throw error;
  }

  const sortedDeployments = deployments
    .slice()
    .sort((left, right) => deploymentTimestamp(right) - deploymentTimestamp(left));

  const freshDeployment = sortedDeployments.find((deployment) => {
    const timestamp = deploymentTimestamp(deployment);
    return timestamp === 0 || timestamp >= earliestAcceptedTimestamp;
  });

  if (!freshDeployment) {
    const error = new Error("Deployment Center has not returned a fresh deployment record for the current handoff yet.");
    error.transient = true;
    throw error;
  }

  return freshDeployment;
}

function classifyDeployment(deployment) {
  if (!deployment || typeof deployment !== "object") {
    return {
      kind: "failed",
      displayStatus: "Malformed",
      errorMessage: "Deployment Center returned an empty or malformed deployment payload."
    };
  }

  const rawStatus = deployment.status;
  const normalizedText = normalizeState(deployment.status_text || deployment.message || deployment.progress || deployment.complete);

  if (rawStatus === KUDU_STATUS.failed) {
    return {
      kind: "failed",
      displayStatus: "Failed",
      errorMessage: extractErrorMessage(deployment) || `Deployment ${deployment.id || "unknown"} failed.`
    };
  }

  if (rawStatus === KUDU_STATUS.success) {
    return {
      kind: "success",
      displayStatus: "Succeeded"
    };
  }

  if (FAILURE_TEXT_STATES.has(normalizedText)) {
    return {
      kind: "failed",
      displayStatus: "Failed",
      errorMessage: extractErrorMessage(deployment) || `Deployment ${deployment.id || "unknown"} failed.`
    };
  }

  if (SUCCESS_TEXT_STATES.has(normalizedText)) {
    return {
      kind: "success",
      displayStatus: "Succeeded"
    };
  }

  if ([KUDU_STATUS.pending, KUDU_STATUS.building, KUDU_STATUS.deploying].includes(rawStatus) || ACTIVE_TEXT_STATES.has(normalizedText)) {
    return {
      kind: "active",
      displayStatus: deployment.status_text || statusName(rawStatus) || "In Progress"
    };
  }

  if (rawStatus === undefined && !normalizedText) {
    return {
      kind: "failed",
      displayStatus: "Malformed",
      errorMessage: "Deployment Center returned a deployment record without status information."
    };
  }

  return {
    kind: "active",
    displayStatus: deployment.status_text || deployment.message || statusName(rawStatus) || String(rawStatus || "Unknown")
  };
}

function deploymentTimestamp(deployment) {
  const timestamp = Date.parse((deployment && (deployment.received_time || deployment.start_time || deployment.end_time)) || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function resolveDeploymentError(endpoints, scmAuth, deployment, fallbackMessage, requestJsonFn) {
  const readJson = requestJsonFn || requestJson;

  if (!deployment || !deployment.id) {
    return {
      errorMessage: fallbackMessage || "Deployment failed before a deployment ID was available.",
      verboseDetails: []
    };
  }

  const verboseDetails = [];

  try {
    const logs = await readJson({
      method: "GET",
      url: endpoints.deploymentLog(deployment.id),
      headers: {
        Authorization: scmAuth.authorizationHeader
      },
      retryClass: "poll"
    });

    if (Array.isArray(logs)) {
      for (const logEntry of logs) {
        addVerboseLogDetail(verboseDetails, "deployment log", logEntry);

        if (logEntry && logEntry.id) {
          const detailMessage = await resolveLogDetailError(endpoints, scmAuth, deployment.id, logEntry.id, readJson);
          if (detailMessage) {
            verboseDetails.push(`deployment log detail ${logEntry.id}: ${sanitizeLogMessage(detailMessage)}`);
            return {
              errorMessage: detailMessage,
              verboseDetails
            };
          }
        }
      }

      const nestedMessage = extractErrorMessage(logs);
      if (nestedMessage) {
        return {
          errorMessage: nestedMessage,
          verboseDetails
        };
      }
    } else {
      addVerboseLogDetail(verboseDetails, "deployment log", logs);
      const directMessage = extractErrorMessage(logs);
      if (directMessage) {
        return {
          errorMessage: directMessage,
          verboseDetails
        };
      }
    }
  } catch (error) {
    tl.debug(`Unable to resolve detailed deployment log error: ${getErrorMessage(error)}`);
    verboseDetails.push(`Unable to resolve detailed deployment log error: ${sanitizeLogMessage(getErrorMessage(error))}`);
  }

  return {
    errorMessage: fallbackMessage || `Deployment ${deployment.id} failed.`,
    verboseDetails
  };
}

async function resolveLogDetailError(endpoints, scmAuth, deploymentId, logId, requestJsonFn) {
  const readJson = requestJsonFn || requestJson;

  try {
    const details = await readJson({
      method: "GET",
      url: endpoints.deploymentLogDetails(deploymentId, logId),
      headers: {
        Authorization: scmAuth.authorizationHeader
      },
      retryClass: "poll"
    });

    const message = extractErrorMessage(details);
    if (message) {
      return message;
    }

    return "";
  } catch (error) {
    tl.debug(`Unable to resolve deployment log ${logId}: ${getErrorMessage(error)}`);
    return "";
  }
}

function extractErrorMessage(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractErrorMessage(item);
      if (message) {
        return message;
      }
    }
    return "";
  }

  const directFields = [
    value.error && value.error.message,
    value.error && value.error.details,
    value.errors,
    value.details,
    value.message,
    value.status_text,
    value.progress,
    value.summary,
    value.text
  ];

  for (const field of directFields) {
    const message = extractErrorMessage(field);
    if (message && isFailureLogLevel(value.type || value.log_type || value.level || value.severity || "error")) {
      return message;
    }
  }

  for (const field of directFields) {
    const message = extractErrorMessage(field);
    if (message && looksLikeFailureMessage(message)) {
      return message;
    }
  }

  return "";
}

function looksLikeFailureMessage(message) {
  return /exception|failed|failure|error|denied|forbidden|unauthorized|timeout|timed out|not found|invalid/i.test(message);
}

function isFailureLogLevel(value) {
  if (value === 2 || value === "2") {
    return true;
  }

  return FAILURE_TEXT_STATES.has(normalizeState(value));
}

function addVerboseLogDetail(details, label, value) {
  if (!value || typeof value !== "object") {
    return;
  }

  const message = extractAnyMessage(value);
  if (!message) {
    return;
  }

  const prefix = value.id ? `${label} ${value.id}` : label;
  details.push(`${prefix}: ${sanitizeLogMessage(message)}`);
}

function extractAnyMessage(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractAnyMessage(item);
      if (message) {
        return message;
      }
    }
    return "";
  }

  return extractAnyMessage(value.message || value.status_text || value.progress || value.summary || value.text || value.details || (value.error && value.error.message));
}

function writeVerboseFailureLogs(options) {
  console.log(`Deployment verification failure: deploymentId=${options.deploymentId || "unknown"}; status=${options.status || "Failed"}`);
  console.log(`Deployment verification failure message: ${sanitizeLogMessage(options.errorMessage || "Deployment failed.")}`);

  for (const detail of options.details || []) {
    console.log(`Deployment verification detail: ${detail}`);
  }
}

function sanitizeLogMessage(message) {
  return String(message || "")
    .replace(/(https?:\/\/)([^:\s/@]+):([^@\s/]+)@/gi, "$1***:***@")
    .replace(/(Authorization:\s*)(Bearer|Basic)\s+[^\s,;]+/gi, "$1$2 ***")
    .replace(/((?:client_secret|publishingPassword|password)=)[^&\s]+/gi, "$1***");
}

function normalizeState(value) {
  if (value === true) {
    return "completed";
  }

  if (value === false || value === undefined || value === null) {
    return "";
  }

  return String(value).trim().toLowerCase().replace(/\s+/g, "");
}

function statusName(status) {
  switch (status) {
    case KUDU_STATUS.pending:
      return "Pending";
    case KUDU_STATUS.building:
      return "Building";
    case KUDU_STATUS.deploying:
      return "Deploying";
    case KUDU_STATUS.failed:
      return "Failed";
    case KUDU_STATUS.success:
      return "Succeeded";
    default:
      return "";
  }
}

async function requestJson(options) {
  const response = await requestRawWithRetry(options);
  if (!response.body) {
    return {};
  }

  try {
    return JSON.parse(response.body);
  } catch (error) {
    const parseError = new Error(`Expected JSON from ${redactCredentials(options.url)}, but received an invalid response.`);
    parseError.statusCode = response.statusCode;
    throw parseError;
  }
}

async function requestRawWithRetry(options, requestRawFn, delayFn) {
  const readRaw = requestRawFn || requestRaw;
  const wait = delayFn || delay;
  const maxAttempts = getRequestMaxAttempts(options.retryClass);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await readRaw(options);
    } catch (error) {
      const retryable = isRetryableRequestError(error, options.retryClass);
      const finalAttempt = attempt >= maxAttempts;

      if (!retryable || finalAttempt) {
        if (options.retryClass === "poll" && retryable) {
          error.transient = true;
        }

        throw error;
      }

      tl.debug(
        `Transient ${requestRetryLabel(options.retryClass)} request failure from ${redactCredentials(options.url)}; ` +
        `retrying attempt ${attempt + 1}/${maxAttempts}: ${getErrorMessage(error)}`
      );
      await wait(getRetryDelayMs(attempt));
    }
  }

  throw new Error(`Request retry loop exited unexpectedly for ${redactCredentials(options.url)}.`);
}

async function requestPagedArmCollection(url, accessToken) {
  const values = [];
  let nextUrl = url;

  while (nextUrl) {
    const page = await requestJson({
      method: "GET",
      url: nextUrl,
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      retryClass: "fatal"
    });

    if (Array.isArray(page.value)) {
      values.push(...page.value);
    }

    nextUrl = page.nextLink || "";
  }

  return values;
}

function requestRaw(options) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(options.url);
    const requestOptions = {
      method: options.method || "GET",
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      headers: Object.assign(
        {
          Accept: "application/json",
          "Content-Length": options.body ? Buffer.byteLength(options.body) : 0
        },
        options.headers || {}
      )
    };

    const request = https.request(requestOptions, (response) => {
      const chunks = [];

      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const statusCode = response.statusCode || 0;

        if (statusCode >= 200 && statusCode < 300) {
          resolve({
            statusCode,
            headers: response.headers,
            body
          });
          return;
        }

        const error = new Error(formatHttpError(statusCode, body, options.url));
        error.statusCode = statusCode;
        error.responseBody = body;
        error.transient = options.retryClass === "poll" && isRetryableStatusCode(statusCode, options.retryClass);
        reject(error);
      });
    });

    request.setTimeout(30000, () => {
      const timeoutError = new Error(`Request timed out for ${redactCredentials(options.url)}.`);
      timeoutError.code = "ETIMEDOUT";
      request.destroy(timeoutError);
    });

    request.on("error", (error) => {
      error.transient = options.retryClass === "poll" && isRetryableRequestError(error, options.retryClass);
      reject(error);
    });

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

function getRequestMaxAttempts(retryClass) {
  return retryClass === "poll" ? POLLING_RETRY_ATTEMPTS : SETUP_RETRY_ATTEMPTS;
}

function requestRetryLabel(retryClass) {
  return retryClass === "poll" ? "polling" : "setup";
}

function getRetryDelayMs(attempt) {
  return Math.min(RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1), RETRY_BACKOFF_MAX_MS);
}

function isRetryableRequestError(error, retryClass) {
  if (!error) {
    return false;
  }

  if (isRetryableNetworkErrorCode(error.code)) {
    return true;
  }

  return isRetryableStatusCode(error.statusCode, retryClass);
}

function isRetryableNetworkErrorCode(code) {
  return TRANSIENT_NETWORK_ERROR_CODES.has(String(code || "").toUpperCase());
}

function isRetryableStatusCode(statusCode, retryClass) {
  return isAlwaysRetryableStatusCode(statusCode) || (retryClass === "poll" && isPollingOnlyTransientStatusCode(statusCode));
}

function isAlwaysRetryableStatusCode(statusCode) {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function isPollingOnlyTransientStatusCode(statusCode) {
  return statusCode === 404 || statusCode === 409;
}

function formatHttpError(statusCode, body, url) {
  const message = tryReadErrorMessage(body);
  return `HTTP ${statusCode} from ${redactCredentials(url)}${message ? `: ${message}` : ""}`;
}

function tryReadErrorMessage(body) {
  if (!body) {
    return "";
  }

  try {
    return extractErrorMessage(JSON.parse(body)) || body.slice(0, 500);
  } catch (error) {
    return body.slice(0, 500);
  }
}

function isTransientPollingError(error) {
  return Boolean(error && (error.transient || isRetryableRequestError(error, "poll")));
}

function setOutputs(outputs) {
  tl.setVariable("deploymentStatus", outputs.deploymentStatus || "", false, true);
  tl.setVariable("errorMessage", outputs.errorMessage || "", false, true);
  tl.setVariable("deploymentDuration", String(outputs.deploymentDuration || 0), false, true);
  tl.setVariable("deploymentId", outputs.deploymentId || "", false, true);
}

function secondsSince(startedAt) {
  return Math.round((Date.now() - startedAt) / 1000);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeBaseUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  return rawValue.endsWith("/") ? rawValue : `${rawValue}/`;
}

function normalizeArmResource(resourceManagerEndpointUrl, activeDirectoryResourceId) {
  const endpointUrl = normalizeBaseUrl(resourceManagerEndpointUrl);
  if (endpointUrl) {
    return endpointUrl;
  }

  const resourceId = normalizeBaseUrl(activeDirectoryResourceId);
  if (resourceId && !/management\.core\.windows\.net/i.test(resourceId)) {
    return resourceId;
  }

  return DEFAULT_ARM_RESOURCE;
}

function trimLeadingSlash(value) {
  return String(value || "").replace(/^\/+/, "");
}

function getResourceGroupNameFromResourceId(resourceId) {
  const match = String(resourceId || "").match(/\/resourceGroups\/([^/]+)/i);
  return match ? decodeURIComponent(match[1]) : "";
}

function getErrorMessage(error) {
  if (!error) {
    return "Unknown error.";
  }

  return error.message || String(error);
}

function redactCredentials(value) {
  try {
    const parsed = new URL(value);
    parsed.username = parsed.username ? "***" : "";
    parsed.password = parsed.password ? "***" : "";
    return parsed.toString();
  } catch (error) {
    return String(value || "").replace(/\/\/[^:@/]+:[^@/]+@/g, "//***:***@");
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  classifyDeployment,
  extractErrorMessage,
  isFailureLogLevel,
  isTransientPollingError,
  requestRawWithRetry,
  resolveDeploymentError,
  sanitizeLogMessage,
  writeVerboseFailureLogs
};
