"use strict";

import * as functions from "firebase-functions";
import admin from "firebase-admin";
import {HttpsError} from "firebase-functions/v1/https";
import * as lnd from "./lnd.js";


// Initialize Firestore
admin.initializeApp();
const walletsCollection = admin.firestore().collection("wallets");
const usersCollection = admin.firestore().collection("users");
const addressesCollection = admin.firestore().collection("addresses");

export const createWallet = functions.
    https.onCall(async (data, context) => {
    // verify Firebase Auth ID token
      if (!context.auth) {
        throw new HttpsError("unauthenticated", "Authetication is required!");
      }

      const userId = context.auth.uid;
      const email = context.auth.token.email || null;
      const name = context.auth.token.name || null;


      // Checks if the user is already in the database
      const userRef = usersCollection.doc(userId);
      const userCheck = await userRef.get();

      if (userCheck.exists) {
        throw new HttpsError("already-exists", "This user is already in the " +
        "database. Use addWallet to add another wallet to this user");
      }

      // Connect to the lnd server and activate lightining (if needed)
      await lnd.activateLightning();

      let address;
      if (lnd.grpc.state == "active") {
        const {Lightning} = lnd.grpc.services;
        const NESTED_PUBKEY_HASH = 1;

        const result = await Lightning.newAddress({type: NESTED_PUBKEY_HASH});
        if (result != null) {
          address = result.address;
        } else {
          throw new HttpsError("aborted",
              "Error when trying to to retrieve a new address.");
        }
      } else {
        throw new HttpsError("aborted",
            "Error when trying to to retrieve a new address.");
      }

      // Creates the wallet document
      const walletDoc = {
        "current_address": address,
        "current_balance": 0,
        "last_updated": new Date(),
        "owner_id": userId,
        "addresses": [address],
      };

      const walletDocRef = walletsCollection.doc();

      // Creates the address document
      const addressDoc = {
        "wallet_id": walletDocRef.id,
      };

      // Creates the user document
      const userDoc = {
        "email": email,
        "name": name,
        "current_wallet_id": walletDocRef.id,
        "associated_wallet_ids": [walletDocRef.id],
      };

      // Creates the batch (commit everything together or rollback otherwise)
      const batch = admin.firestore().batch();
      batch.set(walletDocRef, walletDoc);
      batch.set(usersCollection.doc(userId), userDoc);
      batch.set(addressesCollection.doc(address), addressDoc);

      try {
        await batch.commit();
        return {wallet_id: walletDocRef.id};
      } catch (error) {
        console.log(error);
        throw new HttpsError("aborted",
            "An error occurred when commiting changes to the database");
      }
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

      // Connect to the lnd server and activate lightining (if needed)
      await lnd.activateLightning();

      if (lnd.grpc.state == "active") {
        const {Lightning} = lnd.grpc.services;
        const balance = await Lightning.walletBalance();
        return {wallet_balance: balance};
      } else {
        throw new HttpsError("aborted",
            "Error when trying to activate lightning");
      }
    });

export const getTransactions = functions.
    https.onCall(async (data, context) => {
    // verify Firebase Auth ID token
      if (!context.auth) {
        return {message: "Authentication Required!", code: 401};
      }

      // Connect to the lnd server and activate lightining (if needed)
      await lnd.activateLightning();

      if (lnd.grpc.state == "active") {
        const {Lightning} = lnd.grpc.services;
        const transactions = await Lightning.getTransactions({start_height: 0});
        return {transactions: transactions};
      } else {
        throw new HttpsError("aborted",
            "Error when trying to activate lightning");
      }
    });

