function leer(texto) {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

exports.handler = async (event) => {
  const nombre = process.env.AWS_LAMBDA_FUNCTION_NAME;
  const registros = event.Records || [];

  for (const registro of registros) {
    const externo = leer(registro.body);
    const mensaje = externo && externo.Message
      ? leer(externo.Message)
      : externo;

    console.log("[" + nombre + "] mensaje recibido:", JSON.stringify(mensaje));
  }

  console.log("[" + nombre + "] lote procesado: " + registros.length + " mensaje(s)");
  return { procesados: registros.length };
};
