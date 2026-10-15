import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Sin `import "./register"`: `usageContract` no toca `vscode` y esta ausencia es
// deliberada. Si alguien le mete una dependencia del API, este fichero deja de
// compilar en lugar de pasar a depender del stub sin que nadie se dé cuenta.
import {
  USAGE_URL,
  WINDOW_ORDER,
  describeReset,
  httpFailure,
  isLimited,
  parseUsage,
  type UsageSnapshot,
} from "../src/usage/usageContract";

/** Payload mínimo que el servicio devuelve cuando todo va bien. */
function payload(overrides: Record<string, unknown> = {}): unknown {
  const ventana = (percent: number, extra: Record<string, unknown> = {}) => ({
    percent,
    status: "ok",
    ...extra,
  });
  return {
    usage: {
      rolling: ventana(42),
      weekly: ventana(38),
      monthly: ventana(61),
      ...overrides,
    },
  };
}

function ok(payload: unknown): UsageSnapshot {
  const parsed = parseUsage(payload);
  assert.ok(parsed.ok, `se esperaba un payload válido y salió: ${JSON.stringify(parsed)}`);
  return parsed.snapshot;
}

describe("USAGE_URL", () => {
  // El endpoint cambió de /zen/v1 a /zen/go/v1; si vuelve a cambiar, el indicador
  // deja de recibir datos y esto lo dice antes que el usuario.
  test("apunta al servicio Zen go v1 sobre https", () => {
    assert.equal(USAGE_URL, "https://opencode.ai/zen/go/v1/usage");
  });

  test("el orden de presentación es 5 h, semanal, mensual", () => {
    assert.deepEqual([...WINDOW_ORDER], ["rolling", "weekly", "monthly"]);
  });
});

describe("parseUsage", () => {
  test("acepta un payload completo", () => {
    const snapshot = ok(payload());
    assert.equal(snapshot.rolling.percent, 42);
    assert.equal(snapshot.weekly.percent, 38);
    assert.equal(snapshot.monthly.percent, 61);
    assert.equal(snapshot.rolling.limited, false);
  });

  test("acota el porcentaje al rango 0..100", () => {
    assert.equal(ok(payload({ rolling: { percent: 140 } })).rolling.percent, 100);
    assert.equal(ok(payload({ rolling: { percent: -20 } })).rolling.percent, 0);
  });

  test("redondea el porcentaje a entero", () => {
    assert.equal(ok(payload({ weekly: { percent: 42.4 } })).weekly.percent, 42);
    assert.equal(ok(payload({ weekly: { percent: 42.6 } })).weekly.percent, 43);
  });

  // Pintar un 0% inventado es peor que no pintar nada: el usuario creería que
  // tiene cuota entera cuando en realidad no se pudo leer.
  test("rechaza el payload si falta una ventana", () => {
    assert.deepEqual(parseUsage({ usage: { rolling: { percent: 1 }, weekly: { percent: 1 } } }), {
      ok: false,
      reason: "invalid",
    });
  });

  test("rechaza el payload si el porcentaje no es numérico", () => {
    for (const mala of ["42", null, undefined, NaN, {}]) {
      const parsed = parseUsage(payload({ monthly: { percent: mala } }));
      assert.deepEqual(parsed, { ok: false, reason: "invalid" }, `aceptó: ${JSON.stringify(mala)}`);
    }
  });

  test("rechaza un payload sin el envoltorio usage", () => {
    for (const mala of [{}, null, "texto", 42, [], { rolling: { percent: 1 } }]) {
      assert.deepEqual(parseUsage(mala), { ok: false, reason: "invalid" });
    }
  });

  // El servicio puede añadir campos sin que la extensión deje de funcionar.
  test("tolera campos desconocidos", () => {
    const snapshot = ok({
      usage: {
        rolling: { percent: 10, status: "ok", resetsAt: "2026-01-01T00:00:00Z", futuro: { x: 1 } },
        weekly: { percent: 20 },
        monthly: { percent: 30 },
      },
      plan: "go",
      cuenta: 7,
    });
    assert.equal(snapshot.rolling.percent, 10);
  });

  test("marca como limitada solo la ventana con status rate-limited", () => {
    const snapshot = ok({
      usage: {
        rolling: { percent: 10, status: "ok" },
        weekly: { percent: 20, status: "rate-limited" },
        monthly: { percent: 30, status: "ok" },
      },
    });
    assert.equal(snapshot.rolling.limited, false);
    assert.equal(snapshot.weekly.limited, true);
    assert.equal(snapshot.monthly.limited, false);
    assert.equal(isLimited(snapshot), true);
  });

  test("un status desconocido cuenta como no limitada", () => {
    const snapshot = ok({ usage: { rolling: { percent: 1, status: "otra-cosa" }, weekly: { percent: 1 }, monthly: { percent: 1 } } });
    assert.equal(snapshot.rolling.limited, false);
    assert.equal(isLimited(snapshot), false);
  });

  test("resetsAt ausente deja undefined sin invalidar la ventana", () => {
    assert.equal(ok(payload()).rolling.resetsAt, undefined);
  });

  test("resetsAt no textual se descarta en vez de propagarse", () => {
    const snapshot = ok(payload({ rolling: { percent: 1, resetsAt: 12345 } }));
    assert.equal(snapshot.rolling.resetsAt, undefined);
  });
});

describe("httpFailure", () => {
  // 401 y 403 son acciones distintas para el usuario: una pide clave nueva y
  // otra ni la va a arreglar. No se pueden agrupar en «error».
  test("separa clave rechazada de cuenta sin suscripción", () => {
    assert.equal(httpFailure(401), "unauthorized");
    assert.equal(httpFailure(403), "no-subscription");
  });

  test("cualquier 2xx es utilizable", () => {
    assert.equal(httpFailure(200), undefined);
    assert.equal(httpFailure(204), undefined);
  });

  test("el resto es fallo de red", () => {
    for (const status of [404, 429, 500, 502, 503]) {
      assert.equal(httpFailure(status), "network", `status ${status}`);
    }
  });
});

describe("describeReset", () => {
  const AHORA = Date.parse("2026-01-10T12:00:00Z");

  test("sin fecha no hay nada que describir", () => {
    assert.equal(describeReset(undefined, AHORA), undefined);
  });

  test("una fecha pasada se describe como ahora", () => {
    assert.deepEqual(describeReset("2026-01-10T11:00:00Z", AHORA), { kind: "now" });
    assert.deepEqual(describeReset("2026-01-10T12:00:00Z", AHORA), { kind: "now" });
  });

  test("elige la unidad según la distancia", () => {
    assert.deepEqual(describeReset("2026-01-10T12:30:00Z", AHORA), {
      kind: "duration",
      hours: 0,
      minutes: 30,
    });
    assert.deepEqual(describeReset("2026-01-10T17:00:00Z", AHORA), {
      kind: "duration",
      hours: 5,
      minutes: 0,
    });
    assert.deepEqual(describeReset("2026-01-14T12:00:00Z", AHORA), {
      kind: "days",
      days: 4,
      hours: 0,
    });
  });

  // Las horas solas perdían información: 3 h 05' y 3 h 55' se veían iguales.
  test("las horas van con los minutos de sobra", () => {
    assert.deepEqual(describeReset("2026-01-10T15:25:00Z", AHORA), {
      kind: "duration",
      hours: 3,
      minutes: 25,
    });
    assert.deepEqual(describeReset("2026-01-13T16:40:00Z", AHORA), {
      kind: "days",
      days: 3,
      hours: 4,
    });
  });

  test("menos de un minuto cuenta como ahora", () => {
    assert.deepEqual(describeReset("2026-01-10T12:00:30Z", AHORA), { kind: "now" });
  });

  // El límite exacto: 23 h 59' sigue siendo duración con sus minutos, 24 h
  // exactos cruza a días.
  test("cruza de horas a días en 24", () => {
    assert.deepEqual(describeReset("2026-01-11T11:59:00Z", AHORA), {
      kind: "duration",
      hours: 23,
      minutes: 59,
    });
    assert.deepEqual(describeReset("2026-01-11T12:00:00Z", AHORA), {
      kind: "days",
      days: 1,
      hours: 0,
    });
  });

  // Una fecha ilegible se enseña tal cual: interpretarla sería mentir.
  test("una fecha ilegible se devuelve cruda", () => {
    assert.deepEqual(describeReset("mañana", AHORA), { kind: "raw", value: "mañana" });
  });
});
