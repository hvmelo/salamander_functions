import admin from "firebase-admin";
import * as functions from "firebase-functions";
import {FieldValue} from "firebase-admin/firestore";

const db = admin.firestore();
const walletsCollection = db.collection("wallets");

export const onIncomingTxStatusUpdate = functions.firestore
    .document("wallets/{walletId}/incoming_txs/{tx_hash}")
    .onWrite(async (change, context) => {
      const address = change.after.data()["address"];
      const walletId = context.params.walletId;

      console.log(`Detected an status update for address ${address} ` +
      `of wallet '${walletId}'. Updating wallet balance..`);

      await db.runTransaction(async (t) => {
        const walletRef = walletsCollection.doc(walletId);
        const walletSnap = await walletRef.get();
        const incomingTxColRef = walletRef.collection("incoming_txs");

        const collectionSnap = await incomingTxColRef.get();

        if (collectionSnap.empty) {
          console.log(`No incoming txs found for wallet '${walletId}'`);
          return;
        }
        const incomingBalance = collectionSnap.docs.reduce((accum, doc) => {
          if (doc.data()["status"] == "CONFIRMED") {
            accum["confirmed_balance"] += doc.data()["amount"];
          } else {
            accum["unconfirmed_balance"] += doc.data()["amount"];
          }
          return accum;
        }, {"confirmed_balance": 0, "unconfirmed_balance": 0});

        const walletData = walletSnap.data();
        const totalAvailable =
        incomingBalance["confirmed_balance"] -
        (walletData.balance?.outgoing?.confirmed ?? 0) -
        (walletData.balance?.outgoing?.unconfirmed ?? 0);

        t.set(walletRef,
            {
              balance: {
                total_available: totalAvailable,
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
        "Total available for payments (incoming - outgoing " +
        `(conf + unconf)): ${totalAvailable}.`,
        );
      });
    });

