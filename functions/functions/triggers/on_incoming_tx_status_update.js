import admin from "firebase-admin";
import * as functions from "firebase-functions";
import {FieldValue} from "firebase-admin/firestore";

const db = admin.firestore();
const addressesCollection = db.collection("addresses");

export const onIncomingTxStatusUpdate = functions.firestore
    .document("addresses/{address}/incoming_txs/{tx_hash}")
    .onWrite(async (change, context) => {
      const address = context.params.address;

      console.log(`Detected an status update for address ${address}. ` +
        "Updating balances...");

      await db.runTransaction(async (t) => {
        const addressRef = addressesCollection.doc(address);
        const incomingTxColRef = addressRef.collection("incoming_txs");

        const collectionSnap = await incomingTxColRef.get();
        const addressBalance = collectionSnap.docs.reduce((accum, doc) => {
          if (doc.data()["status"] == "CONFIRMED") {
            accum["confirmed_balance"] += doc.data()["amount"];
          } else {
            accum["unconfirmed_balance"] += doc.data()["amount"];
          }
          return accum;
        }, {"confirmed_balance": 0, "unconfirmed_balance": 0});

        t.update(addressRef,
            {
              confirmed_balance:
            addressBalance["confirmed_balance"],
              unconfirmed_balance:
            addressBalance["unconfirmed_balance"],
              last_updated: FieldValue.serverTimestamp(),
            });

        console.log(`Updated balance for address ${address}. Confirmed: ` +
        `${addressBalance["confirmed_balance"]}. ` +
        `Unconfirmed: ${addressBalance["unconfirmed_balance"]}.`,
        );
      });
    });

