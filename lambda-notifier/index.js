function leer(texto) {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

exports.handler = async (event) => {
  const base = (process.env.API_NOTIFICATION || "")
    .trim()
    .replace(/\/+$/, "");
  const token = process.env.API_TOKEN_INTEGRATION;

  if (!base || !token) {
    throw new Error("Faltan API_NOTIFICATION y/o API_TOKEN_INTEGRATION");
  }

  const url = base + (/\/api$/i.test(base) ? "" : "/api") + "/saas/notices";

  for (const registro of event.Records || []) {
    const externo = leer(registro.body);
    const mensaje = externo && externo.Message
      ? leer(externo.Message)
      : externo;

    const texto = (
      typeof mensaje === "string" ? mensaje : JSON.stringify(mensaje)
    ).slice(0, 2000);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "ApiKey " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: texto }),
      redirect: "manual"
    });

    if (!res.ok) {
      throw new Error("La API respondió HTTP " + res.status);
    }

    console.log(
      "Aviso publicado (HTTP " + res.status + "):",
      texto.slice(0, 120)
    );
  }
};
