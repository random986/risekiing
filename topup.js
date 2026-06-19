import derivWS from './src/lib/derivWS.js';

console.log("Connecting to Deriv for topup...");
const DEMO_TOKEN = 'zC1SkSXgajB5ymD';

derivWS.onStatusChange = (status) => {
  console.log(`Status: ${status}`);
};

derivWS.connect(DEMO_TOKEN);

const interval = setInterval(async () => {
  if (derivWS.isReady) {
    clearInterval(interval);
    console.log("Authorized! Sending topup request...");
    try {
      const res = await derivWS.send({ topup_virtual: 1 });
      console.log("Topup Response:", JSON.stringify(res, null, 2));
    } catch (e) {
      console.error("Topup request failed:", e);
    }
    derivWS.disconnect();
    process.exit(0);
  }
}, 500);
