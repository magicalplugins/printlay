<?php
/**
 * PrintLay Settings Page
 *
 * Admin settings page for configuring the PrintLay connection.
 */

defined('ABSPATH') || exit;

class PrintLay_Settings {

    private static ?self $instance = null;

    public static function instance(): self {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        add_action('admin_menu', [$this, 'add_menu']);
        add_action('admin_init', [$this, 'register_settings']);
        add_action('wp_ajax_printlay_test_connection', [$this, 'ajax_test_connection']);
    }

    public function add_menu(): void {
        add_menu_page(
            __('PrintLay', 'printlay-woocommerce'),
            __('PrintLay', 'printlay-woocommerce'),
            'manage_woocommerce',
            'printlay-settings',
            [$this, 'render_settings_page'],
            'dashicons-format-image',
            56
        );
    }

    public function register_settings(): void {
        register_setting('printlay_settings', 'printlay_api_key', [
            'type'              => 'string',
            'sanitize_callback' => 'sanitize_text_field',
        ]);
        register_setting('printlay_settings', 'printlay_host', [
            'type'              => 'string',
            'default'           => 'https://printlay.co.uk',
            'sanitize_callback' => 'esc_url_raw',
        ]);
    }

    public function render_settings_page(): void {
        $api_key = get_option('printlay_api_key', '');
        $host = get_option('printlay_host', 'https://printlay.co.uk');
        $has_key = !empty($api_key);

        $linked_products = $this->get_linked_products();
        ?>
        <div class="wrap">
            <h1><?php esc_html_e('PrintLay Settings', 'printlay-woocommerce'); ?></h1>

            <form method="post" action="options.php">
                <?php settings_fields('printlay_settings'); ?>

                <table class="form-table">
                    <tr>
                        <th scope="row">
                            <label for="printlay_host"><?php esc_html_e('PrintLay Host', 'printlay-woocommerce'); ?></label>
                        </th>
                        <td>
                            <input type="url" id="printlay_host" name="printlay_host"
                                   value="<?php echo esc_attr($host); ?>"
                                   class="regular-text" placeholder="https://printlay.co.uk" />
                            <p class="description"><?php esc_html_e('The URL of your PrintLay instance.', 'printlay-woocommerce'); ?></p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">
                            <label for="printlay_api_key"><?php esc_html_e('API Key', 'printlay-woocommerce'); ?></label>
                        </th>
                        <td>
                            <input type="password" id="printlay_api_key" name="printlay_api_key"
                                   value="<?php echo esc_attr($api_key); ?>"
                                   class="regular-text" placeholder="pl_live_..." autocomplete="off" />
                            <p class="description">
                                <?php esc_html_e('Your PrintLay merchant API key. Find this in PrintLay > Widget > API Keys.', 'printlay-woocommerce'); ?>
                            </p>
                        </td>
                    </tr>
                </table>

                <?php submit_button(); ?>
            </form>

            <?php if ($has_key): ?>
            <hr />
            <h2><?php esc_html_e('Connection Status', 'printlay-woocommerce'); ?></h2>
            <p>
                <button type="button" class="button" id="printlay-test-connection">
                    <?php esc_html_e('Test Connection', 'printlay-woocommerce'); ?>
                </button>
                <span id="printlay-connection-result" style="margin-left: 10px;"></span>
            </p>

            <hr />
            <h2><?php esc_html_e('Linked Products', 'printlay-woocommerce'); ?></h2>
            <?php if (empty($linked_products)): ?>
                <p class="description"><?php esc_html_e('No products linked yet. Enable PrintLay Designer on any WooCommerce product to get started.', 'printlay-woocommerce'); ?></p>
            <?php else: ?>
                <table class="wp-list-table widefat fixed striped">
                    <thead>
                        <tr>
                            <th><?php esc_html_e('WooCommerce Product', 'printlay-woocommerce'); ?></th>
                            <th><?php esc_html_e('PrintLay Product ID', 'printlay-woocommerce'); ?></th>
                            <th><?php esc_html_e('Status', 'printlay-woocommerce'); ?></th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ($linked_products as $item): ?>
                        <tr>
                            <td>
                                <a href="<?php echo esc_url(get_edit_post_link($item['wc_id'])); ?>">
                                    <?php echo esc_html($item['title']); ?>
                                </a>
                            </td>
                            <td><code><?php echo esc_html($item['printlay_id']); ?></code></td>
                            <td><span class="dashicons dashicons-yes-alt" style="color: #46b450;"></span> <?php esc_html_e('Linked', 'printlay-woocommerce'); ?></td>
                        </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
            <?php endif; ?>
            <?php endif; ?>
        </div>

        <script>
        jQuery(function($) {
            $('#printlay-test-connection').on('click', function() {
                var $btn = $(this);
                var $result = $('#printlay-connection-result');
                $btn.prop('disabled', true);
                $result.text('Testing...');
                $.post(ajaxurl, { action: 'printlay_test_connection', _wpnonce: '<?php echo wp_create_nonce('printlay_test'); ?>' }, function(res) {
                    $btn.prop('disabled', false);
                    if (res.success) {
                        $result.html('<span style="color:#46b450;font-weight:bold;">\u2713 Connected (' + res.data.product_count + ' products available)</span>');
                    } else {
                        $result.html('<span style="color:#dc3232;font-weight:bold;">\u2717 ' + res.data + '</span>');
                    }
                }).fail(function() {
                    $btn.prop('disabled', false);
                    $result.html('<span style="color:#dc3232;">Request failed</span>');
                });
            });
        });
        </script>
        <?php
    }

    public function ajax_test_connection(): void {
        check_ajax_referer('printlay_test', '_wpnonce');
        if (!current_user_can('manage_woocommerce')) {
            wp_send_json_error(__('Permission denied.', 'printlay-woocommerce'));
        }

        $api = new PrintLay_API();
        $products = $api->list_products();

        if (is_wp_error($products)) {
            wp_send_json_error($products->get_error_message());
        }

        wp_send_json_success(['product_count' => is_array($products) ? count($products) : 0]);
    }

    private function get_linked_products(): array {
        $args = [
            'post_type'  => 'product',
            'meta_query' => [
                [
                    'key'     => '_printlay_enabled',
                    'value'   => 'yes',
                    'compare' => '=',
                ],
            ],
            'posts_per_page' => -1,
            'fields'         => 'ids',
        ];
        $ids = get_posts($args);
        $results = [];

        foreach ($ids as $id) {
            $printlay_id = get_post_meta($id, '_printlay_product_id', true);
            if ($printlay_id) {
                $results[] = [
                    'wc_id'       => $id,
                    'title'       => get_the_title($id),
                    'printlay_id' => $printlay_id,
                ];
            }
        }
        return $results;
    }
}
