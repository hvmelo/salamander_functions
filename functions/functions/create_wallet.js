import admin from "firebase-admin";
import * as functions from "firebase-functions";
import {HttpsError} from "firebase-functions/v1/https";
import * as lnd from "../init/lnd_init.js";

const db = admin.firestore();
const walletsCollection = db.collection("wallets");
const usersCollection = db.collection("users");
const addressesCollection = db.collection("addresses");

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
          console.log(`Created a new address for user ${userId} with ` +
          `hash ${address}.`);
        } else {
          throw new HttpsError("aborted",
              "Error when trying to to retrieve a new address.");
        }
      } else {
        throw new HttpsError("aborted",
            "Error when trying to to retrieve a new address.");
      }

      const dateNow = new Date();

      // Creates the wallet document
      const walletDoc = {
        balance: {
          total_settled: 0,
          incoming: {
            confirmed: 0,
            unconfirmed: 0,
          },
          outgoing: {
            confirmed: 0,
            unconfirmed: 0,
          },
        },
        active_address: address,
        created: dateNow,
        last_updated: dateNow,
        owner_id: userId,
        associated_addresses: [address],
      };

      const walletDocRef = walletsCollection.doc();

      // Creates the address document
      const addressDoc = {
        wallet_id: walletDocRef.id,
      };

      // Creates the user document
      const userDoc = {
        email: email,
        name: name,
        active_wallet_id: walletDocRef.id,
        associated_wallet_ids: [walletDocRef.id],
      };

      // Creates the batch (commit everything together or rollback otherwise)
      const batch = db.batch();
      batch.set(walletDocRef, walletDoc);
      batch.set(usersCollection.doc(userId), userDoc);
      batch.set(addressesCollection.doc(address), addressDoc);

      console.log("Successfully created a new wallet with id " +
                `${walletDocRef.id} for user ${userId}`);


      try {
        await batch.commit();
        return {wallet_id: walletDocRef.id};
      } catch (error) {
        console.log(error);
        throw new HttpsError("aborted",
            "An error occurred when commiting changes to the database");
      }
    });
