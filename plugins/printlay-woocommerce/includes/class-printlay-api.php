<?php
/**
 * PrintLay API Client
 *
 * Handles all communication with the PrintLay API.
 */

defined('ABSPATH') || exit;

class PrintLay_API {

    private string $api_key;
    private string $host;

    public function __construct(?string $api_key = null, ?string $host = null) {
        $this->api_key = $api_key ?? get_option('printlay_api_key', '');
        $this->host = rtrim($host ?? get_option('printlay_host', 'https://printlay.co.uk'), '/');
    }

    public function get_host(): string {
        return $this->host;
    }

    /**
     * Test the connection by listing products.
     * Returns true on success or a WP_Error on failure.
     */
    public function test_connection() {
        $response = $this->request('GET', '/api/v1/widget/products');
        if (is_wp_error($response)) {
            return $response;
        }
        return true;
    }

    /**
     * Fetch available PrintLay products for linking.
     *
     * @return array|WP_Error
     */
    public function list_products() {
        return $this->request('GET', '/api/v1/widget/products');
    }

    /**
     * Mint a widget session for a given product.
     *
     * @param string $product_id PrintLay product UUID
     * @param string $external_ref Optional WC reference (cart key, order id, etc.)
     * @return array|WP_Error  { session_token, expires_in, product }
     */
    public function create_session(string $product_id, string $external_ref = '') {
        $body = ['product_id' => $product_id];
        if ($external_ref) {
            $body['external_ref'] = $external_ref;
        }
        return $this->request('POST', '/api/v1/widget/sessions', $body);
    }

    /**
     * Make an authenticated request to the PrintLay API.
     *
     * @param string $method HTTP method
     * @param string $path API path (e.g. /api/v1/widget/sessions)
     * @param array|null $body JSON body for POST/PUT
     * @return array|WP_Error Decoded response or error
     */
    private function request(string $method, string $path, ?array $body = null) {
        if (empty($this->api_key)) {
            return new WP_Error('printlay_no_key', __('PrintLay API key is not configured.', 'printlay-woocommerce'));
        }

        $url = $this->host . $path;
        $args = [
            'method'  => $method,
            'headers' => [
                'Authorization' => 'Bearer ' . $this->api_key,
                'Content-Type'  => 'application/json',
                'Accept'        => 'application/json',
            ],
            'timeout' => 15,
        ];

        if ($body !== null && in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
            $args['body'] = wp_json_encode($body);
        }

        $response = wp_remote_request($url, $args);

        if (is_wp_error($response)) {
            return $response;
        }

        $code = wp_remote_retrieve_response_code($response);
        $decoded = json_decode(wp_remote_retrieve_body($response), true);

        if ($code < 200 || $code >= 300) {
            $message = $decoded['detail'] ?? $decoded['message'] ?? "HTTP {$code}";
            return new WP_Error('printlay_api_error', $message, ['status' => $code]);
        }

        return $decoded;
    }
}
