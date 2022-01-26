"use strict";

import * as functions from "firebase-functions";
import admin from "firebase-admin";
import {HttpsError} from "firebase-functions/v1/https";
import LndGrpc from "lnd-grpc";
import {SecretManagerServiceClient} from "@google-cloud/secret-manager";

// Initialize Firestore
admin.initializeApp();
const walletsCollection = admin.firestore().collection("wallets");
const usersCollection = admin.firestore().collection("users");

// Initialize the Secret Manager
const project = "projects/salamander-cloud";
const MACAROON_RESOURCE_NAME =
  `${project}/secrets/lnd-server-admin-macaroon/versions/latest`;
const PASSWORD_RESOURCE_NAME =
  `${project}/secrets/lnd-server-wallet-password/versions/latest`;
const TLS_CERT_RESOURCE_NAME =
  `${project}/secrets/lnd-server-tls-cert/versions/latest`;


// Initialize LND client
const LND_HOST = "salamanderlnd.ddns.net";
const LND_PORT = 10009;

// Declare the grpc (will be lazy initialized)
let grpc;
let walletPassword;

export const createWallet = functions.
    https.onCall((data, context) => {
    // verify Firebase Auth ID token
      if (!context.auth) {
        return {message: "Authentication Required!", code: 401};
      }

      const userId = context.auth.uid;
      const walletDoc = {
        "current_balance": 0,
        "last_updated": new Date(),
        "owner_id": userId,
      };

      const walletDocRef = walletsCollection.doc();

      const userDoc = {
        "current_wallet_id": walletDocRef.id,
      };

      const batch = admin.firestore().batch();
      batch.set(walletDocRef, walletDoc);
      batch.set(usersCollection.doc(userId), userDoc);

      return batch.commit()
          .then((writeResult) => {
            console.log(writeResult);
            return {wallet_id: walletDocRef.id};
          })
          .catch((err) => {
            console.log(err);
            throw new HttpsError("write-wallet-error",
                "Error while writing to the database");
          });
    });

// Saves a message to the Firebase Realtime Database but sanitizes the
// text by removing swearwords.
export const addMessage = functions.https.
    onCall((data, context) => {
    // Message text passed from the client.
      const text = data.text;

      // Checking attribute.
      if (!(typeof text === "string") || text.length === 0) {
      // Throwing an HttpsError so that the client gets the error details.
        throw new HttpsError("invalid-argument",
            "The function must be called with one arguments \"text\" " +
        "containing the message text to add.");
      }
      // Checking that the user is authenticated.
      if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
        throw new HttpsError("failed-precondition",
            "The function must be called while authenticated.");
      }

      // Authentication / user information is automatically added to the
      // request.
      const uid = context.auth.uid;
      const name = context.auth.token.name || null;
      const picture = context.auth.token.picture || null;
      const email = context.auth.token.email || null;

      // Saving the new message to Firestore.
      return admin.firestore().collection("messages").add({
        text: text.toUpperCase(),
        author: {uid, name, picture, email},
      }).then(() => {
        console.log("New Message written");
        // Returning the sanitized message to the client.
        return {text: text.toUpperCase()};
      })
          .catch((error) => {
            // Re-throwing the error as an HttpsError so that the client
            // gets the error details.
            throw new HttpsError("unknown", error.message, error);
          });
    });


export const walletBalance = functions.
    https.onCall(async (data, context) => {
    // verify Firebase Auth ID token
      if (!context.auth) {
        return {message: "Authentication Required!", code: 401};
      }

      if (grpc == null) {
        grpc = await connectToServer();
      }

      if (grpc.state != "active") {
        await grpc.connect();
        if (grpc.state == "ready") {
          throw new HttpsError("server-offline", "Can't connect to LND server");
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
          throw new HttpsError("wrong-password", "Can't connect to LND server");
        }
      }

      if (grpc.state == "active") {
        const {Lightning} = grpc.services;
        const balance = await Lightning.walletBalance();
        console.log(balance);
        return {wallet_balance: balance};
      } else {
        throw new HttpsError("wallet-balance-error",
            "Error while trying to connect to the LND server");
      }
    });

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

/**
 * Connects to the LND server.
 * @return {grpc} The grpc connection object.
 */
async function connectToServer() {
  const macaroon = await getSecret(MACAROON_RESOURCE_NAME);
  const cert = await getSecret(TLS_CERT_RESOURCE_NAME);

  return new LndGrpc({
    host: `${LND_HOST}:${LND_PORT}`,
    cert: cert.toString(),
    macaroon: macaroon.toString("hex"),
  });
}
