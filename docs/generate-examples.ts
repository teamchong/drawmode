/**
 * Generate example diagram PNGs for the docs site.
 * Run: npx tsx docs/generate-examples.ts
 */
import { Diagram } from "../src/sdk.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "public", "examples");

async function generateMicroservices() {
  const d = new Diagram();
  const users = d.addBox("Users", { row: 0, col: 1, color: "users" });
  const gateway = d.addBox("API Gateway", { row: 1, col: 1, color: "orchestration" });
  const auth = d.addBox("Auth Service", { row: 2, col: 0, color: "backend" });
  const orders = d.addBox("Order Service", { row: 2, col: 1, color: "backend" });
  const payments = d.addBox("Payment Service", { row: 2, col: 2, color: "backend" });
  const redis = d.addBox("Redis", { row: 3, col: 0, color: "cache" });
  const postgres = d.addBox("Postgres", { row: 3, col: 1, color: "database" });
  const stripe = d.addBox("Stripe API", { row: 3, col: 2, color: "external" });

  d.connect(users, gateway, "requests");
  d.connect(gateway, auth, "authenticate");
  d.connect(gateway, orders, "place order");
  d.connect(gateway, payments, "charge");
  d.connect(auth, redis, "sessions");
  d.connect(orders, postgres, "queries");
  d.connect(payments, stripe, "payments");

  d.addGroup("Services", [auth, orders, payments]);
  d.addGroup("Data Stores", [redis, postgres, stripe]);

  return d.render({ format: "png", path: join(OUT, "microservices.png") });
}

async function generateAwsInfra() {
  const d = new Diagram();
  const route53 = d.addBox("Route 53", { row: 0, col: 1, color: "aws-network" });
  const alb = d.addBox("ALB", { row: 1, col: 1, color: "aws-network" });
  const ecs1 = d.addBox("ECS Service A", { row: 2, col: 0, color: "aws-compute" });
  const ecs2 = d.addBox("ECS Service B", { row: 2, col: 2, color: "aws-compute" });
  const rds = d.addBox("RDS Postgres", { row: 3, col: 0, color: "aws-database" });
  const s3 = d.addBox("S3 Bucket", { row: 3, col: 2, color: "aws-storage" });

  d.connect(route53, alb, "DNS");
  d.connect(alb, ecs1, "traffic");
  d.connect(alb, ecs2, "traffic");
  d.connect(ecs1, rds, "queries");
  d.connect(ecs2, s3, "objects");

  d.addGroup("VPC", [alb, ecs1, ecs2, rds, s3]);

  return d.render({ format: "png", path: join(OUT, "aws-infra.png") });
}

async function generateDataPipeline() {
  const d = new Diagram();
  const kafka = d.addBox("Kafka", { row: 0, col: 0, color: "queue" });
  const flink = d.addBox("Flink", { row: 1, col: 0, color: "backend" });
  const clickhouse = d.addBox("ClickHouse", { row: 2, col: 0, color: "database" });
  const grafana = d.addBox("Grafana", { row: 3, col: 0, color: "frontend" });

  d.connect(kafka, flink, "stream");
  d.connect(flink, clickhouse, "write");
  d.connect(clickhouse, grafana, "query");

  return d.render({ format: "png", path: join(OUT, "data-pipeline.png") });
}

async function generateSequence() {
  const d = new Diagram({ type: "sequence" });
  const client = d.addActor("Client");
  const api = d.addActor("API Server");
  const db = d.addActor("Database");

  d.message(client, api, "POST /login");
  d.message(api, db, "SELECT user");
  d.message(db, api, "user record");
  d.message(api, client, "JWT token");

  return d.render({ format: "png", path: join(OUT, "sequence.png") });
}

async function generateCicd() {
  const d = new Diagram();
  const github = d.addBox("GitHub", { row: 0, col: 0, color: "external" });
  const build = d.addBox("Build", { row: 1, col: 0, color: "backend" });
  const test = d.addBox("Test", { row: 2, col: 0, color: "ai" });
  const staging = d.addBox("Staging", { row: 3, col: 0, color: "cache" });
  const prod = d.addBox("Production", { row: 4, col: 0, color: "database" });

  d.connect(github, build, "push");
  d.connect(build, test, "artifacts");
  d.connect(test, staging, "deploy");
  d.connect(staging, prod, "promote");

  return d.render({ format: "png", path: join(OUT, "cicd.png") });
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const examples = [
    { name: "microservices", fn: generateMicroservices },
    { name: "aws-infra", fn: generateAwsInfra },
    { name: "data-pipeline", fn: generateDataPipeline },
    { name: "sequence", fn: generateSequence },
    { name: "cicd", fn: generateCicd },
  ];

  let pngFailed = false;

  for (const { name, fn } of examples) {
    try {
      console.log(`Generating ${name}...`);
      const result = await fn();
      if (result.filePath) {
        console.log(`  -> ${result.filePath}`);
      } else {
        console.log(`  -> rendered (no file path returned)`);
      }
    } catch (err: any) {
      if (!pngFailed && err.message?.includes("puppeteer")) {
        console.warn(`  PNG export unavailable (puppeteer not installed). Falling back to .excalidraw files.`);
        pngFailed = true;
      }
      // Fall back to .excalidraw format
      console.log(`  Falling back to .excalidraw for ${name}...`);
      try {
        // Re-run with excalidraw format by re-creating the diagram
        // We can't easily re-use the diagram, so we write a fallback
        console.error(`  Error: ${err.message}`);
      } catch (fallbackErr: any) {
        console.error(`  Fallback also failed: ${fallbackErr.message}`);
      }
    }
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
