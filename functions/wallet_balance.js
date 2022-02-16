import * as functions from "firebase-functions";
import {HttpsError} from "firebase-functions/v1/https";
import * as lnd from "./lnd.js";


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
