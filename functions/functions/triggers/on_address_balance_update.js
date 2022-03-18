import admin from "firebase-admin";
import * as functions from "firebase-functions";
import {FieldValue} from "firebase-admin/firestore";

const db = admin.firestore();
const addressesCollection = db.collection("addresses");
const walletsCollection = db.collection("wallets");

export const onAddressBalanceUpdate = functions.firestore
    .document("addresses/{address}")
    .onWrite(async (change, context) => {
      const walletId = change.after.data()["wallet_id"];

      console.log("Detected an address balance update for wallet " +
        `'${walletId}'. Updating wallet balances...`);

      await db.runTransaction(async (t) => {
        const walletRef = walletsCollection.doc(walletId);
        const walletSnap = await walletRef.get();
        if (!walletSnap.exists) {
          console.log(`No wallets found with id '${walletId}'`);
          return;
        }

        const addressesSnap = await addressesCollection.
            where("wallet_id", "==", walletId).get();

        if (addressesSnap.empty) {
          console.log(`No matching addresses for wallet id '${walletId}'`);
          return;
        }

        const incomingBalance = addressesSnap.docs.reduce((accum, doc) => {
          accum["confirmed_balance"] += doc.data()["confirmed_balance"];
          accum["unconfirmed_balance"] +=
          doc.data()["unconfirmed_balance"];
          return accum;
        }, {"confirmed_balance": 0, "unconfirmed_balance": 0});

        const walletData = walletSnap.data();
        const totalConfirmed = (walletData.balance?.outgoing?.confirmed ?? 0) +
        incomingBalance["confirmed_balance"];

        t.set(walletRef,
            {
              balance: {
                total_confirmed: totalConfirmed,
                incoming: {
                  confirmed: incomingBalance["confirmed_balance"],
                  unconfirmed: incomingBalance["unconfirmed_balance"],
                },
              },
              last_updated: FieldValue.serverTimestamp(),
            }, {merge: true});

        console.log(`Updated incoming balance for wallet '${walletId}'. ` +
        `Confirmed: ${incomingBalance["confirmed_balance"]}. ` +
        `Unconfirmed: ${incomingBalance["unconfirmed_balance"]}. ` +
        `New total (incoming + outcoming) confirmed: ${totalConfirmed}.`,
        );
      });
    });


