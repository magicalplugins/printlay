<?php
/**
 * PrintLay Order Status Sync
 *
 * Registers a REST endpoint to receive status updates from PrintLay,
 * adds a PrintLay status column to the WC orders list,
 * and shows a meta box with status + "Open in PrintLay" link.
 */

defined('ABSPATH') || exit;

class PrintLay_Order_Status {

    private static ?self $instance = null;

    public static function instance(): self {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        add_action('rest_api_init', [$this, 'register_rest_routes']);
        add_action('add_meta_boxes', [$this, 'add_order_meta_box']);
        add_filter('manage_edit-shop_order_columns', [$this, 'add_order_column']);
        add_action('manage_shop_order_posts_custom_column', [$this, 'render_order_column'], 10, 2);

        // HPOS compatibility
        add_filter('manage_woocommerce_page_wc-orders_columns', [$this, 'add_order_column']);
        add_action('manage_woocommerce_page_wc-orders_custom_column', [$this, 'render_order_column_hpos'], 10, 2);
    }

    /**
     * Register REST endpoint: POST /wp-json/printlay/v1/status-update
     */
    public function register_rest_routes(): void {
        register_rest_route('printlay/v1', '/status-update', [
            'methods'             => 'POST',
            'callback'            => [$this, 'handle_status_update'],
            'permission_callback' => [$this, 'verify_api_key'],
        ]);
    }

    /**
     * Verify the request comes from PrintLay using the API key.
     */
    public function verify_api_key(\WP_REST_Request $request): bool {
        $auth = $request->get_header('authorization');
        $api_key = get_option('printlay_api_key', '');
        if (empty($api_key)) return false;
        return $auth === 'Bearer ' . $api_key;
    }

    /**
     * Handle incoming status updates from PrintLay.
     */
    public function handle_status_update(\WP_REST_Request $request): \WP_REST_Response {
        $design_ref   = sanitize_text_field($request->get_param('design_ref') ?? '');
        $status       = sanitize_text_field($request->get_param('status') ?? '');
        $proof_status = sanitize_text_field($request->get_param('proof_status') ?? '');

        if (empty($design_ref)) {
            return new \WP_REST_Response(['error' => 'Missing design_ref'], 400);
        }

        // Find the WC order by design ref
        $orders = wc_get_orders([
            'meta_key'   => '_printlay_design_ref',
            'meta_value' => $design_ref,
            'limit'      => 1,
        ]);

        if (empty($orders)) {
            return new \WP_REST_Response(['error' => 'Order not found'], 404);
        }

        $order = $orders[0];
        $order->update_meta_data('_printlay_status', $status);
        if ($proof_status) {
            $order->update_meta_data('_printlay_proof_status', $proof_status);
        }
        $order->add_order_note(
            sprintf(__('PrintLay: Status → %s%s', 'printlay-woocommerce'),
                $status,
                $proof_status ? " (proof: {$proof_status})" : ''
            )
        );
        $order->save();

        return new \WP_REST_Response(['status' => 'ok'], 200);
    }

    /**
     * Add meta box to the order edit page.
     */
    public function add_order_meta_box(): void {
        $screen = class_exists('\Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController')
            ? wc_get_page_screen_id('shop-order')
            : 'shop_order';

        add_meta_box(
            'printlay_status_box',
            __('PrintLay', 'printlay-woocommerce'),
            [$this, 'render_meta_box'],
            $screen,
            'side',
            'default'
        );
    }

    /**
     * Render the meta box content.
     */
    public function render_meta_box($post_or_order): void {
        $order = ($post_or_order instanceof \WP_Post)
            ? wc_get_order($post_or_order->ID)
            : $post_or_order;

        if (!$order) return;

        $design_ref   = $order->get_meta('_printlay_design_ref');
        $pl_status    = $order->get_meta('_printlay_status') ?: '—';
        $proof_status = $order->get_meta('_printlay_proof_status');
        $host         = get_option('printlay_host', 'https://printlay.co.uk');

        echo '<p><strong>' . esc_html__('Status:', 'printlay-woocommerce') . '</strong> ';
        echo '<span class="printlay-status-badge">' . esc_html(ucwords(str_replace('_', ' ', $pl_status))) . '</span></p>';

        if ($proof_status) {
            echo '<p><strong>' . esc_html__('Proof:', 'printlay-woocommerce') . '</strong> ';
            echo esc_html(ucwords(str_replace('_', ' ', $proof_status))) . '</p>';
        }

        if ($design_ref) {
            $url = trailingslashit($host) . 'app/widget/orders';
            echo '<p><a href="' . esc_url($url) . '" target="_blank" class="button button-small">';
            echo esc_html__('Open in PrintLay →', 'printlay-woocommerce');
            echo '</a></p>';
        } else {
            echo '<p class="description">' . esc_html__('No PrintLay design associated.', 'printlay-woocommerce') . '</p>';
        }
    }

    /**
     * Add PrintLay status column to orders list.
     */
    public function add_order_column(array $columns): array {
        $new = [];
        foreach ($columns as $key => $label) {
            $new[$key] = $label;
            if ($key === 'order_status') {
                $new['printlay_status'] = __('PrintLay', 'printlay-woocommerce');
            }
        }
        return $new;
    }

    /**
     * Render the column content (legacy CPT-based orders).
     */
    public function render_order_column(string $column, int $post_id): void {
        if ($column !== 'printlay_status') return;
        $order = wc_get_order($post_id);
        if (!$order) return;
        $this->echo_status_badge($order);
    }

    /**
     * Render the column content (HPOS-based orders).
     */
    public function render_order_column_hpos(string $column, $order): void {
        if ($column !== 'printlay_status') return;
        if (!($order instanceof \WC_Order)) return;
        $this->echo_status_badge($order);
    }

    private function echo_status_badge(\WC_Order $order): void {
        $design_ref = $order->get_meta('_printlay_design_ref');
        if (empty($design_ref)) {
            echo '—';
            return;
        }

        $status = $order->get_meta('_printlay_status') ?: 'draft';
        $proof  = $order->get_meta('_printlay_proof_status');

        $colors = [
            'draft'          => '#6b7280',
            'paid'           => '#0ea5e9',
            'ready_to_print' => '#8b5cf6',
            'printed'        => '#16a34a',
        ];
        $proof_colors = [
            'awaiting_proof'  => '#f59e0b',
            'proof_sent'      => '#0ea5e9',
            'proof_approved'  => '#16a34a',
            'proof_rejected'  => '#dc2626',
        ];

        $color = $colors[$status] ?? '#6b7280';
        echo '<span style="color:' . esc_attr($color) . ';font-weight:600;font-size:12px">';
        echo esc_html(ucwords(str_replace('_', ' ', $status)));
        echo '</span>';

        if ($proof) {
            $pc = $proof_colors[$proof] ?? '#6b7280';
            echo '<br><span style="color:' . esc_attr($pc) . ';font-size:11px">';
            echo esc_html(ucwords(str_replace('_', ' ', $proof)));
            echo '</span>';
        }
    }
}
