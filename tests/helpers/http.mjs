export async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      }),
  };
}

export function requester(base, token) {
  return async (
    path,
    { method = 'GET', body, rawBody, auth = token, contentType = 'application/json' } = {},
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(auth !== null ? { Authorization: `Bearer ${auth}` } : {}),
        ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': contentType } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(rawBody !== undefined ? { body: rawBody } : {}),
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      data:
        text && response.headers.get('content-type')?.includes('application/json')
          ? JSON.parse(text)
          : null,
    };
  };
}
