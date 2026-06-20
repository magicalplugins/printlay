<?php
/**
 * PrintLay Frontend
 *
 * Handles the product page display: replaces WC add-to-cart with the PrintLay designer overlay.
 */

defined('ABSPATH') || exit;

class PrintLay_Frontend {

    private static ?self $instance = null;

    public static function instance(): self {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
        add_action('wp_ajax_printlay_create_session', [$this, 'ajax_create_session']);
        add_action('wp_ajax_nopriv_printlay_create_session', [$this, 'ajax_create_session']);
        add_filter('woocommerce_get_price_html', [$this, 'modify_price_html'], 10, 2);
        add_action('woocommerce_single_product_summary', [$this, 'render_designer_button'], 30);
        add_action('woocommerce_before_add_to_cart_form', [$this, 'hide_add_to_cart_form']);
        add_filter('woocommerce_product_get_price', [$this, 'set_base_price'], 10, 2);
        add_filter('woocommerce_product_get_regular_price', [$this, 'set_base_price'], 10, 2);
        add_action('wp_footer', [$this, 'render_overlay_container']);
    }

    public function enqueue_assets(): void {
        if (!is_product()) return;

        global $post;
        if (get_post_meta($post->ID, '_printlay_enabled', true) !== 'yes') return;

        wp_enqueue_style(
            'printlay-frontend',
            PRINTLAY_WC_PLUGIN_URL . 'assets/css/printlay-frontend.css',
            [],
            PRINTLAY_WC_VERSION
        );
        wp_enqueue_script(
            'printlay-frontend',
            PRINTLAY_WC_PLUGIN_URL . 'assets/js/printlay-frontend.js',
            ['jquery'],
            PRINTLAY_WC_VERSION,
            true
        );
        wp_localize_script('printlay-frontend', 'printlayData', [
            'ajaxUrl'    => admin_url('admin-ajax.php'),
            'nonce'      => wp_create_nonce('printlay_session'),
            'productId'  => get_post_meta($post->ID, '_printlay_product_id', true),
            'wcProductId'=> $post->ID,
            'host'       => rtrim(get_option('printlay_host', 'https://printlay.co.uk'), '/'),
            'cartNonce'  => wp_create_nonce('printlay_add_cart'),
            'cartUrl'    => wc_get_cart_url(),
            'i18n'       => [
                'loading'  => __('Loading designer...', 'printlay-woocommerce'),
                'error'    => __('Could not load the designer. Please try again.', 'printlay-woocommerce'),
                'added'    => __('Added to cart!', 'printlay-woocommerce'),
            ],
        ]);
    }

    /**
     * Ensure the product has a base price so WooCommerce considers it purchasable.
     * We use the "from" price or fallback to 0.01 (overridden in cart anyway).
     */
    public function set_base_price($price, $product) {
        if (!$product) return $price;
        $product_id = $product->get_id();
        if (get_post_meta($product_id, '_printlay_enabled', true) !== 'yes') {
            return $price;
        }
        if (empty($price) || floatval($price) <= 0) {
            $from = get_post_meta($product_id, '_printlay_from_price', true);
            return $from && floatval($from) > 0 ? $from : '0.01';
        }
        return $price;
    }

    /**
     * Show "From £X.XX" pricing instead of the standard WC price.
     */
    public function modify_price_html(string $price_html, $product): string {
        if (!$product) return $price_html;

        $product_id = $product->get_id();
        if (get_post_meta($product_id, '_printlay_enabled', true) !== 'yes') {
            return $price_html;
        }

        $from_price = get_post_meta($product_id, '_printlay_from_price', true);
        if ($from_price && floatval($from_price) > 0) {
            return '<span class="printlay-from-price">' .
                   esc_html__('From', 'printlay-woocommerce') . ' ' .
                   wc_price($from_price) .
                   '</span>';
        }

        return '<span class="printlay-from-price">' . esc_html__('Price calculated in designer', 'printlay-woocommerce') . '</span>';
    }

    /**
     * Hide the native add-to-cart form on product pages with PrintLay enabled.
     */
    public function hide_add_to_cart_form(): void {
        global $post;
        if (!$post || get_post_meta($post->ID, '_printlay_enabled', true) !== 'yes') return;
        echo '<style>.single_add_to_cart_button, form.cart .quantity, form.cart button[type="submit"] { display: none !important; }</style>';
    }

    /**
     * Render the "Customize & Order" button in the product summary.
     */
    public function render_designer_button(): void {
        global $post;
        if (get_post_meta($post->ID, '_printlay_enabled', true) !== 'yes') return;
        if (!get_post_meta($post->ID, '_printlay_product_id', true)) return;
        ?>
        <div class="printlay-designer-trigger">
            <button type="button" id="printlay-open-designer" class="button alt wp-element-button printlay-btn">
                <?php esc_html_e('Customize & Order', 'printlay-woocommerce'); ?>
            </button>
        </div>
        <?php
    }

    /**
     * Render the overlay container in the footer (hidden by default).
     */
    public function render_overlay_container(): void {
        if (!is_product()) return;
        global $post;
        if (get_post_meta($post->ID, '_printlay_enabled', true) !== 'yes') return;
        ?>
        <div id="printlay-overlay" class="printlay-overlay" style="display:none;" aria-hidden="true">
            <div class="printlay-overlay-header">
                <span class="printlay-overlay-title"><?php esc_html_e('Design Your Sticker', 'printlay-woocommerce'); ?></span>
                <button type="button" class="printlay-overlay-close" id="printlay-close-designer" aria-label="<?php esc_attr_e('Close', 'printlay-woocommerce'); ?>">
                    &times;
                </button>
            </div>
            <div class="printlay-overlay-body">
                <div class="printlay-loading" id="printlay-loading">
                    <div class="printlay-spinner"></div>
                    <p><?php esc_html_e('Loading designer...', 'printlay-woocommerce'); ?></p>
                </div>
                <iframe id="printlay-iframe" class="printlay-iframe" allow="clipboard-write" style="display:none;"></iframe>
            </div>
        </div>
        <?php
    }

    /**
     * AJAX: create a widget session.
     */
    public function ajax_create_session(): void {
        check_ajax_referer('printlay_session', '_wpnonce');

        $product_id = sanitize_text_field($_POST['product_id'] ?? '');
        $wc_product_id = intval($_POST['wc_product_id'] ?? 0);

        if (!$product_id) {
            wp_send_json_error(__('No PrintLay product specified.', 'printlay-woocommerce'));
        }

        $api = new PrintLay_API();
        $result = $api->create_session($product_id, 'wc_product_' . $wc_product_id);

        if (is_wp_error($result)) {
            wp_send_json_error($result->get_error_message());
        }

        wp_send_json_success([
            'session_token' => $result['session_token'] ?? '',
            'expires_in'    => $result['expires_in'] ?? 7200,
        ]);
    }
}
