import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { FileLog } from "../src/utils/filelog";

let counter = 0;
let fileName: string;
let log: FileLog;

beforeEach(() => {
  fileName = `test-${process.pid}-${Date.now()}-${counter++}.log`;
  log = new FileLog(fileName);
});

afterEach(() => {
  fs.rmSync(log.path, { force: true });
});

describe("FileLog", () => {
  test("el fichero vive en TEMP/opencode-chat y el directorio se crea solo", () => {
    assert.equal(log.path, path.join(process.env.TEMP ?? os.tmpdir(), "opencode-chat", fileName));
    assert.ok(fs.existsSync(path.dirname(log.path)));
  });

  test("cada línea lleva hora, pid y el texto", () => {
    log.write("arranque");
    const [first] = fs.readFileSync(log.path, "utf8").split(/\r?\n/);
    assert.match(first, /^\d{2}:\d{2}:\d{2}\.\d{3} /, `sin marca de tiempo: ${first}`);
    assert.ok(first.includes(`[pid ${process.pid}]`), `sin pid: ${first}`);
    assert.ok(first.endsWith("arranque"), `sin el texto: ${first}`);
  });

  // P-025: la razón de existir de FileLog es que el OutputChannel es asíncrono
  // y se pierde lo último si el extension host se cuelga. Lo que está en disco
  // es lo único que sobrevive, así que NADA puede quedarse solo en memoria.
  test("lo que se escribe llega íntegro a disco, aunque se pasen del tope en memoria", () => {
    const total = 250;
    for (let i = 0; i < total; i++) {
      log.write(`linea ${i}`);
    }
    const onDisk = fs.readFileSync(log.path, "utf8").split(/\r?\n/).filter(Boolean);
    assert.equal(onDisk.length, total, "faltan líneas en disco");
    assert.ok(onDisk[0].endsWith("linea 0"));
    assert.ok(onDisk[total - 1].endsWith(`linea ${total - 1}`));
    // Las 250 están en orden, sin huecos.
    onDisk.forEach((line, i) => assert.ok(line.endsWith(`linea ${i}`), `desorden en ${i}: ${line}`));
  });

  test("en memoria retiene como máximo 200 líneas (las más recientes)", () => {
    for (let i = 0; i < 250; i++) {
      log.write(`linea ${i}`);
    }
    const kept = log.tail(1000).split("\n");
    assert.equal(kept.length, 200, `retenidas: ${kept.length}`);
    assert.ok(kept[0].endsWith("linea 50"), kept[0]);
    assert.ok(kept[199].endsWith("linea 249"), kept[199]);
  });

  test("tail() devuelve las últimas 40 por defecto y respeta el pedido", () => {
    for (let i = 0; i < 100; i++) {
      log.write(`linea ${i}`);
    }
    assert.equal(log.tail().split("\n").length, 40);
    assert.equal(log.tail(3).split("\n").length, 3);
    assert.ok(log.tail(3).split("\n")[0].endsWith("linea 97"));
  });

  test("tail() vacío devuelve cadena vacía, no undefined", () => {
    assert.equal(log.tail(), "");
  });

  test("escribir nunca lanza, aunque el fichero no se pueda crear", () => {
    assert.doesNotThrow(() => log.write("algo"));
    assert.doesNotThrow(() => log.write("otra cosa"));
  });

  test("las líneas vacías también se guardan", () => {
    log.write("");
    log.write("tras el vacío");
    const onDisk = fs.readFileSync(log.path, "utf8").split(/\r?\n/).filter(Boolean);
    assert.equal(onDisk.length, 2);
    assert.ok(onDisk[1].endsWith("tras el vacío"));
  });
});
