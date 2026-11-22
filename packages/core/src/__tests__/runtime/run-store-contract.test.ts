import { InMemoryRunStore } from "../../index.js";
import { runStoreContractTests } from "./run-store-contract.js";

// A future SQLite / Postgres store is verified by the same suite: runStoreContractTests("SqliteRunStore", () => new SqliteRunStore(...)).
runStoreContractTests("InMemoryRunStore", () => new InMemoryRunStore());
