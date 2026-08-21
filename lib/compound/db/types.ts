import type { Client, PoolClient } from "pg";

/**
 * Anything a query can be run on: a client borrowed from the pool, or a
 * standalone session. Every read and write in db/ takes one of these rather
 * than reaching for the pool itself, so a caller can compose several of them
 * inside one transaction.
 */
export type Queryable = PoolClient | Client;
