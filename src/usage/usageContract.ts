/**
 * Contrato de la API de uso de OpenCode Zen.
 *
 * Este módulo NO importa `vscode`: es lógica pura, así que los tests corren el
 * código de producción real sin stub. Lo único que vive aquí es la forma de la
 * respuesta y cómo se degrada — quién formatea y quién traduce es asunto de
 * `usageStatus`.
 *
 * La API se conoce por observación de la extensión pública
 * `mfenderov/opencode-copilot-sync` (MIT). Es un contrato de servicio, no código.
 */

/** Endpoint de cuotas. Requiere `Authorization: Bearer <api key>`. */
export const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/**
 * Orden de presentación. `rolling` es una ventana DESLIZANTE de 5 horas, no un
 * día — la etiqueta «diario» sería mentira, y de aquí sale el nombre que se ve.
 */
export const WINDOW_ORDER = ["rolling", "weekly", "monthly"] as const;

export type WindowKey = (typeof WINDOW_ORDER)[number];

export interface UsageWindow {
  /** Porcentaje consumido, ya redondeado y acotado a 0..100. */
  percent: number;
  /** `status === "rate-limited"`: la ventana sigue contando pero está frenada. */
  limited: boolean;
  /** ISO 8601. Puede faltar y la ventana sigue siendo válida. */
  resetsAt: string | undefined;
}

export interface UsageSnapshot {
  rolling: UsageWindow;
  weekly: UsageWindow;
  monthly: UsageWindow;
}

/**
 * Motivo de fallo, sin mezlar red con credenciales: 401 y 403 no son lo mismo y
 * el usuario actúa distinto ante cada uno.
 */
export type UsageFailure = "unauthorized" | "no-subscription" | "network" | "invalid";

export type ParsedUsage = { ok: true; snapshot: UsageSnapshot } | { ok: false; reason: UsageFailure };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  // `typeof null === "object"`, por eso el descarte explícito de null y arrays.
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseWindow(value: unknown): UsageWindow | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const { percent, status, resetsAt } = record;
  // Un porcentaje ausente o no numérico invalida la ventana entera: mejor
  // negarse a pintar que enseñar un 0% inventado.
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return undefined;
  }
  return {
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    limited: status === "rate-limited",
    resetsAt: typeof resetsAt === "string" ? resetsAt : undefined,
  };
}

/**
 * Valida la respuesta del servicio.
 *
 * Exige las tres ventanas: si falta una, la cuota que se vería sería a medias y
 * sin forma de saber qué ventana miente. Se rechaza entera.
 *
 * Tolera campos de sobra — el servicio puede añadir ventanas nuevas sin que la
 * extensión deje de funcionar.
 */
export function parseUsage(json: unknown): ParsedUsage {
  const root = asRecord(json);
  const usage = root ? asRecord(root.usage) : undefined;
  if (!usage) {
    return { ok: false, reason: "invalid" };
  }

  const snapshot = {} as Record<WindowKey, UsageWindow>;
  for (const key of WINDOW_ORDER) {
    const window = parseWindow(usage[key]);
    if (!window) {
      return { ok: false, reason: "invalid" };
    }
    snapshot[key] = window;
  }
  return { ok: true, snapshot: snapshot as UsageSnapshot };
}

/**
 * Traduce un código HTTP a motivo de fallo, o `undefined` si la respuesta es
 * utilizable. Los códigos fuera de 2xx no se pueden leer: la API devuelve cuerpo
 * legible solo para 401/403.
 */
export function httpFailure(status: number): UsageFailure | undefined {
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "no-subscription";
  }
  return status >= 200 && status < 300 ? undefined : "network";
}

/** ¿Alguna ventana está frenada? Señal para el fondo de aviso de la barra. */
export function isLimited(snapshot: UsageSnapshot): boolean {
  return WINDOW_ORDER.some(key => snapshot[key].limited);
}

/** Cuándo se restablece una ventana, reducido a lo que se puede traducir. */
export type RelativeReset =
  | { kind: "now" }
  | { kind: "min" | "h" | "d"; value: number }
  /** Fecha que no se pudo interpretar: se muestra tal cual, sin interpretarla. */
  | { kind: "raw"; value: string };

/**
 * Reduce `resetsAt` a una unidad. Devuelve el dato, no la frase: traducir aquí
 * obligaría a importar `vscode` y este módulo tiene que seguir siendo puro.
 *
 * Se redondea hacia ABAJO, no al más cercano. Con redondeo al más cercano, un
 * restablecimiento a 23 h 59' produciría 24 h, que ya no cumple `< 24`, y el
 * dato saltaría a «1 d» — anunciaría mal la cuota. Para una cuenta atrás,
 * decir «23 h» cuando faltan 23 h 59' es conservador y correcto; lo contrario
 * adelantaría el momento.
 */
export function describeReset(resetsAt: string | undefined, now: number): RelativeReset | undefined {
  if (!resetsAt) {
    return undefined;
  }
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) {
    return { kind: "raw", value: resetsAt };
  }
  const diffMs = target - now;
  if (diffMs <= 0) {
    return { kind: "now" };
  }
  const minutes = Math.floor(diffMs / 60_000);
  // Menos de un minuto: la unidad más fina ya no informa, solo estorba.
  if (minutes < 1) {
    return { kind: "now" };
  }
  if (minutes < 60) {
    return { kind: "min", value: minutes };
  }
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) {
    return { kind: "h", value: hours };
  }
  return { kind: "d", value: Math.floor(diffMs / 86_400_000) };
}
