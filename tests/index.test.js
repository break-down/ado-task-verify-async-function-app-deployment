"use strict";

const assert = require("assert");
const {
  extractErrorMessage,
  isFailureLogLevel,
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
