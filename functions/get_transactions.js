import * as functions from "firebase-functions";
import {HttpsError} from "firebase-functions/v1/https";
import * as lnd from "./lnd.js";

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
        return {transactions};
      } else {
        throw new HttpsError("aborted",
            "Error when trying to activate lightning");
      }
    });
