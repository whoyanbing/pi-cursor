import { createHash } from "node:crypto";
// Hypothesis: percentUsed = totalSpend / (limit + bonus) × 100?
const total = 15685, included = 2000, bonus = 13685, limit = 2000;
console.log("total/limit:", (total / limit * 100).toFixed(1));                 // 784
console.log("total/(limit+bonus):", (total / (limit + bonus) * 100).toFixed(2)); // 700
// in cents? total $156.85 of included $20 + bonus $136.85:
console.log("as dollars: total=$%.2f included=$%.2f bonus=$%.2f limit=$%.2f", total/100, included/100, bonus/100, limit/100);
// Maybe percent is requests-based, spend is cents. includedSpend=limit=2000 cents=$20
