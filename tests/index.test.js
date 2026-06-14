"use strict";

const assert = require("assert");
const {
  extractErrorMessage,
  isFailureLogLevel,
  isTransientPollingError,
  requestRawWithRetry,
  resolveDeploymentError,
  sanitizeLogMessage,
  writeVerboseFailureLogs
} = require("../VerifyAsyncFunctionAppDeployment/index");

async function run() {
  assert.strictEqual(isFailureLogLevel(2), true);
  assert.strictEqual(isFailureLogLevel("error"), true);
  assert.strictEqual(isFailureLogLevel("warning"), false);

  assert.strictEqual(
    extractErrorMessage({
      type: 2,
      message: "Trigger sync could not complete"
    }),
    "Trigger sync could not complete"
  );

  const endpoints = {
    deploymentLog: (deploymentId) => `https://scm.example.test/api/deployments/${deploymentId}/log`,
    deploymentLogDetails: (deploymentId, logId) => `https://scm.example.test/api/deployments/${deploymentId}/log/${logId}`
  };
  const scmAuth = {
    authorizationHeader: "Basic secret"
  };
  const deployment = {
    id: "deployment-1"
  };

  const defaultFailure = await resolveDeploymentError(
    endpoints,
    scmAuth,
    deployment,
    "Deployment deployment-1 failed.",
    async () => [{ type: 2, message: "Package download failed" }]
  );

  assert.strictEqual(defaultFailure.errorMessage, "Package download failed");
  assert.deepStrictEqual(defaultFailure.verboseDetails, ["deployment log: Package download failed"]);

  const nestedFailure = await resolveDeploymentError(
    endpoints,
    scmAuth,
    deployment,
    "Deployment deployment-1 failed.",
    async (options) => {
      if (options.url.endsWith("/log")) {
        return [{ id: "log-1", type: 2, message: "Deployment failed" }];
      }

      return { type: 2, message: "Could not find function entry point" };
    }
  );

  assert.strictEqual(nestedFailure.errorMessage, "Could not find function entry point");
  assert.ok(nestedFailure.verboseDetails.includes("deployment log detail log-1: Could not find function entry point"));

  const quietLogs = captureConsole(() => {
    if (false) {
      writeVerboseFailureLogs({
        deploymentId: "deployment-1",
        status: "Failed",
        errorMessage: defaultFailure.errorMessage,
        details: defaultFailure.verboseDetails
      });
    }
  });

  assert.deepStrictEqual(quietLogs, []);

  const verboseLogs = captureConsole(() => {
    writeVerboseFailureLogs({
      deploymentId: "deployment-1",
      status: "Failed",
      errorMessage: defaultFailure.errorMessage,
      details: defaultFailure.verboseDetails
    });
  });

  assert.ok(verboseLogs.some((line) => line.includes("deploymentId=deployment-1")));
  assert.ok(verboseLogs.some((line) => line.includes("Package download failed")));

  assert.strictEqual(
    sanitizeLogMessage("Authorization: Bearer abc123 https://user:pass@example.test/path?password=s3cret"),
    "Authorization: Bearer *** https://***:***@example.test/path?password=***"
  );

  const setupTimeoutThenSuccessRaw = failThenSucceed(
    [{ code: "ETIMEDOUT", message: "setup timed out" }],
    { statusCode: 200, body: "{}" }
  );
  const setupTimeoutThenSuccess = await requestRawWithRetry(
    {
      method: "GET",
      url: "https://management.azure.com/subscriptions/test",
      retryClass: "fatal"
    },
    setupTimeoutThenSuccessRaw,
    async () => {}
  );

  assert.strictEqual(setupTimeoutThenSuccess.statusCode, 200);
  assert.strictEqual(setupTimeoutThenSuccessRaw.attempts, 2);

  const exhaustedSetupTimeoutsRaw = alwaysFail({ code: "ETIMEDOUT", message: "setup timed out" });
  const exhaustedSetupTimeouts = await captureAsyncError(async () => {
    await requestRawWithRetry(
      {
        method: "GET",
        url: "https://management.azure.com/subscriptions/test",
        retryClass: "fatal"
      },
      exhaustedSetupTimeoutsRaw,
      async () => {}
    );
  });

  assert.strictEqual(exhaustedSetupTimeouts.error.code, "ETIMEDOUT");
  assert.strictEqual(exhaustedSetupTimeouts.error.transient, undefined);
  assert.strictEqual(exhaustedSetupTimeoutsRaw.attempts, 3);

  const setupUnauthorizedRaw = alwaysFail({ statusCode: 401, message: "unauthorized" });
  const setupUnauthorized = await captureAsyncError(async () => {
    await requestRawWithRetry(
      {
        method: "GET",
        url: "https://management.azure.com/subscriptions/test",
        retryClass: "fatal"
      },
      setupUnauthorizedRaw,
      async () => {}
    );
  });

  assert.strictEqual(setupUnauthorized.error.statusCode, 401);
  assert.strictEqual(setupUnauthorizedRaw.attempts, 1);

  const pollServerErrorThenSuccessRaw = failThenSucceed(
    [{ statusCode: 500, message: "server unavailable" }],
    { statusCode: 200, body: "[]" }
  );
  const pollServerErrorThenSuccess = await requestRawWithRetry(
    {
      method: "GET",
      url: "https://scm.example.test/api/deployments",
      retryClass: "poll"
    },
    pollServerErrorThenSuccessRaw,
    async () => {}
  );

  assert.strictEqual(pollServerErrorThenSuccess.statusCode, 200);
  assert.strictEqual(pollServerErrorThenSuccessRaw.attempts, 2);

  const exhaustedPollServerErrorsRaw = alwaysFail({ statusCode: 500, message: "server unavailable" });
  const exhaustedPollServerErrors = await captureAsyncError(async () => {
    await requestRawWithRetry(
      {
        method: "GET",
        url: "https://scm.example.test/api/deployments",
        retryClass: "poll"
      },
      exhaustedPollServerErrorsRaw,
      async () => {}
    );
  });

  assert.strictEqual(exhaustedPollServerErrors.error.statusCode, 500);
  assert.strictEqual(exhaustedPollServerErrors.error.transient, true);
  assert.strictEqual(isTransientPollingError(exhaustedPollServerErrors.error), true);
  assert.strictEqual(exhaustedPollServerErrorsRaw.attempts, 2);

  const pollConflictRaw = alwaysFail({ statusCode: 409, message: "deployment record locked" });
  const pollConflict = await captureAsyncError(async () => {
    await requestRawWithRetry(
      {
        method: "GET",
        url: "https://scm.example.test/api/deployments",
        retryClass: "poll"
      },
      pollConflictRaw,
      async () => {}
    );
  });

  assert.strictEqual(pollConflict.error.transient, true);
  assert.strictEqual(isTransientPollingError(pollConflict.error), true);
  assert.strictEqual(pollConflictRaw.attempts, 2);

  const pollUnauthorizedRaw = alwaysFail({ statusCode: 401, message: "unauthorized" });
  const pollUnauthorized = await captureAsyncError(async () => {
    await requestRawWithRetry(
      {
        method: "GET",
        url: "https://scm.example.test/api/deployments",
        retryClass: "poll"
      },
      pollUnauthorizedRaw,
      async () => {}
    );
  });

  assert.strictEqual(pollUnauthorized.error.statusCode, 401);
  assert.strictEqual(pollUnauthorized.error.transient, undefined);
  assert.strictEqual(isTransientPollingError(pollUnauthorized.error), false);
  assert.strictEqual(pollUnauthorizedRaw.attempts, 1);
}

function failThenSucceed(failures, success) {
  const readRaw = async () => {
    readRaw.attempts += 1;
    const failure = failures[readRaw.attempts - 1];
    if (failure) {
      throw createRequestError(failure);
    }

    return success;
  };

  readRaw.attempts = 0;
  return readRaw;
}

function alwaysFail(failure) {
  const fail = async () => {
    fail.attempts += 1;
    throw createRequestError(failure);
  };

  fail.attempts = 0;
  return fail;
}

function createRequestError(options) {
  const error = new Error(options.message || "request failed");
  if (options.code) {
    error.code = options.code;
  }

  if (options.statusCode) {
    error.statusCode = options.statusCode;
  }

  return error;
}

async function captureAsyncError(callback) {
  try {
    await callback();
  } catch (error) {
    return { error };
  }

  throw new Error("Expected callback to throw.");
}

function captureConsole(callback) {
  const originalLog = console.log;
  const lines = [];
  console.log = (message) => {
    lines.push(String(message));
  };

  try {
    callback();
  } finally {
    console.log = originalLog;
  }

  return lines;
}

run()
  .then(() => {
    console.log("index.test.js passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
