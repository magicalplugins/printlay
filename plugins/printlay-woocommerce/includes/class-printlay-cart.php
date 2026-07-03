<?php
/**
 * PrintLay Cart Integration
 *
 * Handles adding designed items to the WooCommerce cart with correct pricing,
 * design metadata, and thumbnail display.
 */

defined('ABSPATH') || exit;

class PrintLay_Cart {

    private static ?self $instance = null;

    public static function instance(): self {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        add_action('wp_ajax_printlay_add_to_cart', [$this, 'ajax_add_to_cart']);
        add_action('wp_ajax_nopriv_printlay_add_to_cart', [$this, 'ajax_add_to_cart']);
        add_action('woocommerce_before_calculate_totals', [$this, 'override_cart_price']);
        add_filter('woocommerce_get_item_data', [$this, 'display_cart_item_data'], 10, 2);
        add_filter('woocommerce_cart_item_thumbnail', [$this, 'cart_item_thumbnail'], 10, 3);
        add_action('woocommerce_checkout_create_order_line_item', [$this, 'save_order_meta'], 10, 4);
        add_filter('woocommerce_add_cart_item_data', [$this, 'ensure_unique_cart_items'], 10, 3);
        add_action('woocommerce_payment_complete', [$this, 'notify_printlay_paid']);
        add_action('woocommerce_order_status_completed', [$this, 'notify_printlay_paid']);
        add_filter('woocommerce_cart_item_quantity', [$this, 'lock_cart_quantity'], 10, 3);
    }

    /**
     * AJAX handler: add a designed sticker to the WooCommerce cart.
     */
    public function ajax_add_to_cart(): void {
        check_ajax_referer('printlay_add_cart', '_wpnonce');

        $wc_product_id = intval($_POST['wc_product_id'] ?? 0);
        $design_ref    = sanitize_text_field($_POST['design_ref'] ?? '');
        $quote_token   = sanitize_text_field($_POST['quote_token'] ?? '');
        $total         = floatval($_POST['total'] ?? 0);
        $currency      = sanitize_text_field($_POST['currency'] ?? '');
        $quantity      = max(1, intval($_POST['quantity'] ?? 1));
        $options       = json_decode(stripslashes($_POST['options'] ?? '{}'), true) ?: [];
        $thumbnail_url = esc_url_raw($_POST['thumbnail_url'] ?? '');

        if (!$wc_product_id || !$design_ref || !$quote_token || $total <= 0) {
            wp_send_json_error(__('Invalid design data.', 'printlay-woocommerce'));
        }

        $product = wc_get_product($wc_product_id);
        if (!$product) {
            wp_send_json_error(__('Product not found.', 'printlay-woocommerce'));
        }

        // Ensure the product has a price so WC considers it purchasable
        if (empty($product->get_price())) {
            update_post_meta($wc_product_id, '_price', $total / $quantity);
            update_post_meta($wc_product_id, '_regular_price', $total / $quantity);
            $product = wc_get_product($wc_product_id);
        }

        // Temporarily force purchasability for PrintLay products during cart add
        $force_purchasable = function($purchasable, $p) use ($wc_product_id) {
            if ($p->get_id() === $wc_product_id) return true;
            return $purchasable;
        };
        add_filter('woocommerce_is_purchasable', $force_purchasable, 999, 2);

        // Clear any prior notices
        wc_clear_notices();

        $cart_item_data = [
            '_printlay_design_ref'    => $design_ref,
            '_printlay_quote_token'   => $quote_token,
            '_printlay_total'         => $total,
            '_printlay_currency'      => $currency,
            '_printlay_quantity'      => $quantity,
            '_printlay_options'       => $options,
            '_printlay_thumbnail_url' => $thumbnail_url,
        ];

        $cart_key = WC()->cart->add_to_cart($wc_product_id, $quantity, 0, [], $cart_item_data);

        remove_filter('woocommerce_is_purchasable', $force_purchasable, 999);

        if ($cart_key) {
            wp_send_json_success([
                'cart_key' => $cart_key,
                'cart_url' => wc_get_cart_url(),
            ]);
        } else {
            // Capture WC notices for debugging
            $notices = wc_get_notices('error');
            $msg = !empty($notices) ? wp_strip_all_tags($notices[0]['notice'] ?? $notices[0]) : __('Could not add to cart.', 'printlay-woocommerce');
            wc_clear_notices();
            wp_send_json_error($msg);
        }
    }

    /**
     * Override the cart line item price with the PrintLay quote price.
     */
    public function override_cart_price($cart): void {
        if (is_admin() && !defined('DOING_AJAX')) return;
        if (did_action('woocommerce_before_calculate_totals') >= 2) return;

        foreach ($cart->get_cart() as $item) {
            if (!empty($item['_printlay_total']) && !empty($item['_printlay_design_ref'])) {
                $unit_price = floatval($item['_printlay_total']) / max(1, $item['quantity']);
                $item['data']->set_price($unit_price);
            }
        }
    }

    /**
     * Display design options in the cart item summary.
     */
    public function display_cart_item_data(array $item_data, array $cart_item): array {
        if (empty($cart_item['_printlay_design_ref'])) return $item_data;

        $options = $cart_item['_printlay_options'] ?? [];

        if (!empty($options['width_mm']) && !empty($options['height_mm'])) {
            $w_cm = round($options['width_mm'] / 10, 1);
            $h_cm = round($options['height_mm'] / 10, 1);
            $item_data[] = [
                'key'   => __('Size', 'printlay-woocommerce'),
                'value' => "{$w_cm} × {$h_cm} cm",
            ];
        }

        if (!empty($options['cut_style'])) {
            $item_data[] = [
                'key'   => __('Cut Style', 'printlay-woocommerce'),
                'value' => ucfirst(str_replace('_', ' ', $options['cut_style'])),
            ];
        }

        if (!empty($options['vinyl'])) {
            $item_data[] = [
                'key'   => __('Material', 'printlay-woocommerce'),
                'value' => ucfirst($options['vinyl']),
            ];
        }

        if (!empty($options['finish'])) {
            $item_data[] = [
                'key'   => __('Finish', 'printlay-woocommerce'),
                'value' => ucfirst($options['finish']),
            ];
        }

        return $item_data;
    }

    /**
     * Replace the cart item thumbnail with the PrintLay design thumbnail.
     */
    public function cart_item_thumbnail(string $thumbnail, array $cart_item, string $cart_item_key): string {
        if (!empty($cart_item['_printlay_thumbnail_url'])) {
            $url = esc_url($cart_item['_printlay_thumbnail_url']);
            return '<img src="' . $url . '" alt="Custom sticker design" class="printlay-cart-thumb" style="width:80px;height:80px;object-fit:contain;border-radius:6px;background:#f8fafc;" />';
        }
        return $thumbnail;
    }

    /**
     * Save PrintLay metadata to the WooCommerce order line item.
     */
    public function save_order_meta($item, $cart_item_key, $values, $order): void {
        if (!empty($values['_printlay_design_ref'])) {
            $item->add_meta_data('_printlay_design_ref', $values['_printlay_design_ref']);
            $item->add_meta_data('_printlay_quote_token', $values['_printlay_quote_token']);
            $item->add_meta_data('_printlay_total', $values['_printlay_total']);
            $item->add_meta_data('_printlay_options', $values['_printlay_options']);

            $host = get_option('printlay_host', 'https://printlay.co.uk');
            $item->add_meta_data(__('Design', 'printlay-woocommerce'),
                $host . '/app/assets?ref=' . $values['_printlay_design_ref']);
        }
    }

    /**
     * Ensure each design gets its own cart line (even for same WC product).
     */
    public function ensure_unique_cart_items(array $cart_item_data, int $product_id, int $variation_id): array {
        if (!empty($cart_item_data['_printlay_design_ref'])) {
            $cart_item_data['unique_key'] = md5($cart_item_data['_printlay_design_ref'] . microtime());
        }
        return $cart_item_data;
    }

    /**
     * Notify PrintLay that payment is complete for orders containing PrintLay items.
     */
    public function notify_printlay_paid(int $order_id): void {
        $order = wc_get_order($order_id);
        if (!$order) return;

        $host = get_option('printlay_host', 'https://printlay.co.uk');
        $api_key = get_option('printlay_api_key', '');
        if (empty($api_key)) return;

        foreach ($order->get_items() as $item) {
            $design_ref = $item->get_meta('_printlay_design_ref');
            if (empty($design_ref)) continue;

            $url = trailingslashit($host) . 'api/v1/widget/orders/' . $design_ref . '/mark-paid';
            wp_remote_post($url, [
                'timeout' => 10,
                'headers' => [
                    'Content-Type'  => 'application/json',
                    'Authorization' => 'Bearer ' . $api_key,
                ],
                'body' => wp_json_encode([
                    'wc_order_id' => $order_id,
                    'design_ref'  => $design_ref,
                ]),
            ]);

            $order->update_meta_data('_printlay_design_ref', $design_ref);
        }
        $order->save();
    }

    /**
     * Replace quantity input with a fixed display for PrintLay cart items.
     * The quantity is locked because pricing was calculated in the designer.
     */
    public function lock_cart_quantity(string $product_quantity, string $cart_item_key, array $cart_item): string {
        if (!empty($cart_item['_printlay_design_ref'])) {
            $qty = intval($cart_item['quantity']);
            return sprintf(
                '<span class="printlay-qty-locked" style="display:inline-block;padding:4px 12px;background:#f1f5f9;border-radius:6px;font-weight:600;font-size:14px;">%d</span>',
                $qty
            );
        }
        return $product_quantity;
    }
}
