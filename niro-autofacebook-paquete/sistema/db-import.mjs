// Importa (o reimporta) data/niro.json a PostgreSQL, reemplazando lo que haya.
// Uso: npm run db:import [-- ruta/al/archivo.json]
// Detener el panel antes de ejecutarlo para que no escriba a la vez.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import "dotenv/config";
import { PgStore } from "./db.mjs";

const url = process.env.NIRO_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("Definí NIRO_DATABASE_URL en .env antes de importar.");
  process.exit(1);
}
const source = resolve(process.argv[2] || process.env.NIRO_DATABASE || "./data/niro.json");
const data = JSON.parse(await readFile(source, "utf8"));
// Se pasan todas las colecciones del archivo (la copia de emergencia incluye IA,
// explorador de grupos y CRM); las que falten se guardan vacías.
const store = { ...data, profile: data.profile || null, meta: data.meta || {} };
const pg = new PgStore(url);
await pg.init();
await pg.truncateAll();
await pg.save(store);
const stats = await pg.stats();
await pg.close();
console.log(`Importado ${source} → ${stats.database}:`, stats);
