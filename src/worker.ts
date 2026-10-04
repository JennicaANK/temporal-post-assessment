import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: "assessment-starter",
    workflowsPath: require.resolve("./workflows"),
    activities,
  });
  console.log("Worker is polling the assessment-starter task queue.");
  await worker.run();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

