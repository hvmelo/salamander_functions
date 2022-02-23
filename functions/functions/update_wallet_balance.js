import admin from "firebase-admin";
import * as functions from "firebase-functions";
import {FieldValue} from "firebase-admin/firestore";

const db = admin.firestore();
const addressesCollection = db.collection("addresses");
const walletsCollection = db.collection("wallets");

export const updateWalletBalance = functions.firestore
    .document("addresses/{address}")
    .onWrite(async (change, context) => {
      const walletId = change.after.data()["wallet_id"];
      console.log(`The wallet is ${walletId}`);

      await db.runTransaction(async (t) => {
        const walletRef = walletsCollection.doc(walletId);
        const walletSnap = await walletRef.get();
        if (!walletSnap.exists) {
          console.log(`No wallets found with id ${walletId}`);
          return;
        }

        const addressesSnap = await addressesCollection.
            where("wallet_id", "==", walletId).get();

        if (addressesSnap.empty) {
          console.log(`No matching addresses for wallet id ${walletId}`);
          return;
        }

        console.log(addressesSnap.docs);

        const walletBalance = addressesSnap.docs.reduce((accum, doc) => {
          console.log(doc.data());
          accum["confirmed_balance"] += doc.data()["confirmed_balance"];
          accum["pending_balance"] += doc.data()["pending_balance"];
          return accum;
        }, {"confirmed_balance": 0, "pending_balance": 0});

        console.log(walletBalance);

        t.update(walletRef,
            {
              confirmed_balance: walletBalance["confirmed_balance"],
              pending_balance: walletBalance["pending_balance"],
              last_updated: FieldValue.serverTimestamp(),
            });
      });
    });
