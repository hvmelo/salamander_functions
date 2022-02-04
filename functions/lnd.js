import LndGrpc from "lnd-grpc";
import * as functions from "firebase-functions";
import {HttpsError} from "firebase-functions/v1/https";
import {SecretManagerServiceClient} from "@google-cloud/secret-manager";

// Secret Manager paths
const project = `projects/${process.env.GCLOUD_PROJECT}`;
const MACAROON_RESOURCE_NAME =
  `${project}/secrets/lnd-server-admin-macaroon/versions/latest`;
const PASSWORD_RESOURCE_NAME =
  `${project}/secrets/lnd-server-wallet-password/versions/latest`;
const TLS_CERT_RESOURCE_NAME =
  `${project}/secrets/lnd-server-tls-cert/versions/latest`;

// Lnd server configuration
const LND_HOST = functions.config().lnd.host;
const LND_PORT = functions.config().lnd.port;
// Declare the grpc (will be lazily initialized)
let grpc;
let walletPassword;

/**
 * Connect to the LND server and activate lightning
 */
export async function activateLightning() {
  if (grpc == null) {
    const macaroon = await getSecret(MACAROON_RESOURCE_NAME);
    const cert = await getSecret(TLS_CERT_RESOURCE_NAME);

    grpc = new LndGrpc({
      host: `${LND_HOST}:${LND_PORT}`,
      cert: cert.toString(),
      macaroon: macaroon.toString("hex"),
    });
  }

  if (grpc.state != "active") {
    await grpc.connect();
    if (grpc.state == "ready") {
      throw new HttpsError("aborted", "Can't connect to the LND server");
    }
  }

  if (grpc.state === "locked") {
    const {WalletUnlocker} = grpc.services;
    if (walletPassword == null) {
      walletPassword = await getSecret(PASSWORD_RESOURCE_NAME);
    }
    await WalletUnlocker.unlockWallet({
      wallet_password: walletPassword,
    });
    if (grpc.state != "locked") {
      await grpc.activateLightning();
    } else {
      throw new HttpsError("permission-denied", "Can't connect to LND server");
    }
  }
}

/**
 * Retrieves a secret.
 * @param {resourceName} resourceName The resource name
 * @return {secret} The secret.
 */
async function getSecret(resourceName) {
  // Access the secret.
  const secretClient = new SecretManagerServiceClient();
  const [version] =
      await secretClient.accessSecretVersion({name: resourceName});
  return version.payload.data;
}

export {grpc};
