<?php
declare(strict_types=1);

function todoGatewayError(int $status, string $error): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=UTF-8');
    echo json_encode(['error' => $error], JSON_THROW_ON_ERROR);
    exit;
}

function todoGateway(string $prefix, string $backend, string $mode = 'approved'): void
{
    header_remove('X-Powered-By');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET,HEAD,POST,PATCH,DELETE,OPTIONS');
    header('Access-Control-Allow-Headers: Authorization,Content-Type');
    if (!in_array($mode, ['approved', 'preview'], true)) {
        todoGatewayError(503, 'invalid_publication_mode');
    }
    header('X-Todo-Mode: ' . $mode);
    if ($mode === 'preview') {
        header('X-Robots-Tag: noindex, nofollow');
    }

    $uri = $_SERVER['REQUEST_URI'] ?? '';
    $path = explode('?', $uri, 2)[0];
    if (strlen($uri) > 8192 || preg_match('/[\x00-\x20\x7f\\\\]/', $uri)) {
        todoGatewayError(400, 'invalid_path');
    }
    if ($path === $prefix) {
        header('Location: ' . $prefix . '/' . substr($uri, strlen($path)), true, 308);
        return;
    }
    if (!str_starts_with($path, $prefix . '/')) {
        todoGatewayError(404, 'route_not_found');
    }
    $relativePath = substr($path, strlen($prefix));
    $decodedPath = rawurldecode($relativePath);
    if (
        preg_match('/%(?:2f|5c|00|0a|0d)/i', $relativePath)
        || preg_match('~(?:^|/)\.{1,2}(?:/|$)|//|[\x00-\x1f\x7f\\\\]~', $decodedPath)
    ) {
        todoGatewayError(400, 'invalid_path');
    }
    $method = $_SERVER['REQUEST_METHOD'] ?? '';
    if (!in_array($method, ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], true)) {
        header('Allow: GET,HEAD,POST,PATCH,DELETE,OPTIONS');
        todoGatewayError(405, 'method_not_allowed');
    }
    $body = file_get_contents('php://input', false, null, 0, 8193);
    if ($body === false || strlen($body) > 8192) {
        todoGatewayError(400, 'invalid_json_or_request');
    }
    $headers = ['Connection: close', 'Accept-Encoding: identity'];
    foreach ([
        'HTTP_AUTHORIZATION' => 'Authorization',
        'CONTENT_TYPE' => 'Content-Type',
        'CONTENT_ENCODING' => 'Content-Encoding',
        'HTTP_ACCEPT' => 'Accept',
        'HTTP_ORIGIN' => 'Origin',
        'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'Access-Control-Request-Method',
        'HTTP_ACCESS_CONTROL_REQUEST_HEADERS' => 'Access-Control-Request-Headers',
    ] as $key => $name) {
        $value = $_SERVER[$key] ?? ($key === 'HTTP_AUTHORIZATION' ? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null) : null);
        if (is_string($value)) {
            if (preg_match('/[\r\n]/', $value)) {
                todoGatewayError(400, 'invalid_header');
            }
            $headers[] = $name . ': ' . $value;
        }
    }
    // The upstream is fixed at deployment; no client-supplied URL or redirects are followed.
    $context = stream_context_create(['http' => [
        'method' => $method,
        'header' => $headers,
        'content' => $body,
        'protocol_version' => 1.1,
        'follow_location' => 0,
        'ignore_errors' => true,
        'timeout' => 8.0,
    ]]);
    $upstream = @fopen($backend . substr($uri, strlen($prefix)), 'rb', false, $context);
    if ($upstream === false) {
        todoGatewayError(502, 'backend_unavailable');
    }
    $response = stream_get_contents($upstream, 8388609);
    $metadata = stream_get_meta_data($upstream);
    fclose($upstream);
    if ($metadata['timed_out'] ?? false) {
        todoGatewayError(504, 'backend_timeout');
    }
    if ($response === false || strlen($response) > 8388608) {
        todoGatewayError(502, 'invalid_backend_response');
    }
    $status = null;
    foreach ($metadata['wrapper_data'] ?? [] as $line) {
        if (preg_match('~^HTTP/[0-9.]+ ([1-5][0-9]{2})\b~', $line, $match)) {
            $status = (int) $match[1];
        }
    }
    if ($status === null) {
        todoGatewayError(502, 'invalid_backend_response');
    }
    http_response_code($status);
    foreach ($metadata['wrapper_data'] ?? [] as $line) {
        $name = strtolower(explode(':', $line, 2)[0]);
        if (in_array($name, [
            'content-type', 'cache-control', 'content-security-policy', 'referrer-policy',
            'permissions-policy', 'x-content-type-options', 'www-authenticate', 'allow',
            'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
        ], true)) {
            header($line, true);
        }
    }
    if ($method !== 'HEAD' && !in_array($status, [204, 304], true)) {
        echo $response;
    }
}
