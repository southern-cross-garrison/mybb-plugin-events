<?php
/**
 * A stand-in for the 501st Legion API's /legionId/{id}/costumes, for the e2e suite.
 *
 * Global setup copies this to the forum root, and provisioning points the
 * events_legion_api_url setting at it, so no test ever reaches the real API. A test says
 * what the API answers for one Legion ID by writing e2e-legion-api/<id>.json beside it
 * (tests/helpers/legion-api.ts): {"status": 200, "body": {...}}. An ID with no file
 * answers 503, so every other test sees the API as down and the profile field as the
 * source of costumes, exactly as before the API was consulted. Every request is appended
 * to e2e-legion-api/requests.log.
 */
$dir = __DIR__ . '/e2e-legion-api';
$path = isset($_SERVER['PATH_INFO']) ? $_SERVER['PATH_INFO'] : '';

if(is_dir($dir))
{
    file_put_contents($dir . '/requests.log', $path . "\n", FILE_APPEND | LOCK_EX);
}

$response = null;
if(preg_match('#^/legionId/(\d+)/costumes$#', $path, $match) && is_file($dir . '/' . $match[1] . '.json'))
{
    $response = json_decode(file_get_contents($dir . '/' . $match[1] . '.json'), true);
}

if(!is_array($response))
{
    http_response_code(503);
    exit;
}

http_response_code(isset($response['status']) ? (int)$response['status'] : 200);
header('Content-Type: application/json');
echo isset($response['raw']) ? $response['raw'] : json_encode(isset($response['body']) ? $response['body'] : null);
