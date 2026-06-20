<?php
/**
 * PrintLay Product Data Tab
 *
 * Adds a "PrintLay Design" tab to the WooCommerce Product Data panel
 * (similar to how PrintApp integrates).
 */

defined('ABSPATH') || exit;

class PrintLay_Product {

    private static ?self $instance = null;

    public static function instance(): self {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        add_filter('woocommerce_product_data_tabs', [$this, 'add_product_data_tab']);
        add_action('woocommerce_product_data_panels', [$this, 'render_product_data_panel']);
        add_action('woocommerce_process_product_meta', [$this, 'save_meta']);
        add_action('wp_ajax_printlay_fetch_products', [$this, 'ajax_fetch_products']);
        add_action('admin_head', [$this, 'tab_icon_css']);
    }

    /**
     * Add "PrintLay Design" tab to the Product Data section.
     */
    public function add_product_data_tab(array $tabs): array {
        $tabs['printlay'] = [
            'label'    => __('PrintLay Design', 'printlay-woocommerce'),
            'target'   => 'printlay_product_data',
            'class'    => ['show_if_simple', 'show_if_variable'],
            'priority' => 80,
        ];
        return $tabs;
    }

    /**
     * Custom CSS for the tab icon.
     */
    public function tab_icon_css(): void {
        $screen = get_current_screen();
        if (!$screen || $screen->id !== 'product') return;
        ?>
        <style>
            #woocommerce-product-data ul.wc-tabs li.printlay_options a::before {
                content: "\f161";
                font-family: dashicons;
            }
        </style>
        <?php
    }

    /**
     * Render the panel contents.
     */
    public function render_product_data_panel(): void {
        global $post;
        $enabled = get_post_meta($post->ID, '_printlay_enabled', true) === 'yes';
        $product_id = get_post_meta($post->ID, '_printlay_product_id', true);
        $from_price = get_post_meta($post->ID, '_printlay_from_price', true);
        $api_key = get_option('printlay_api_key', '');
        $host = get_option('printlay_host', 'https://printlay.co.uk');

        wp_nonce_field('printlay_save_meta', '_printlay_nonce');
        ?>
        <div id="printlay_product_data" class="panel woocommerce_options_panel">
            <?php if (empty($api_key)): ?>
                <div class="options_group">
                    <p class="form-field" style="color:#dc3232;padding:12px;">
                        <?php esc_html_e('Please configure your API key in PrintLay > Settings first.', 'printlay-woocommerce'); ?>
                        <a href="<?php echo esc_url(admin_url('admin.php?page=printlay-settings')); ?>"><?php esc_html_e('Go to Settings', 'printlay-woocommerce'); ?></a>
                    </p>
                </div>
            <?php else: ?>
                <div class="options_group">
                    <?php
                    woocommerce_wp_checkbox([
                        'id'          => '_printlay_enabled',
                        'label'       => __('Enable PrintLay Designer', 'printlay-woocommerce'),
                        'description' => __('Replace standard add-to-cart with the PrintLay sticker designer.', 'printlay-woocommerce'),
                        'value'       => $enabled ? 'yes' : 'no',
                    ]);
                    ?>
                </div>

                <div class="options_group printlay-linked-fields" style="<?php echo $enabled ? '' : 'display:none;'; ?>">
                    <p class="form-field">
                        <label for="_printlay_product_id"><?php esc_html_e('Linked PrintLay Product', 'printlay-woocommerce'); ?></label>
                        <select name="_printlay_product_id" id="_printlay_product_id" class="select short">
                            <?php if ($product_id): ?>
                                <option value="<?php echo esc_attr($product_id); ?>" selected><?php echo esc_html($product_id); ?></option>
                            <?php else: ?>
                                <option value=""><?php esc_html_e('— Select a product —', 'printlay-woocommerce'); ?></option>
                            <?php endif; ?>
                        </select>
                        <span class="description"><?php esc_html_e('Select which PrintLay product this WooCommerce product should use.', 'printlay-woocommerce'); ?></span>
                    </p>

                    <?php
                    woocommerce_wp_text_input([
                        'id'                => '_printlay_from_price',
                        'label'             => __('"From" Price (SEO)', 'printlay-woocommerce'),
                        'description'       => __('Shown on product page & Google (e.g. "From £5.00"). Actual price calculated in designer.', 'printlay-woocommerce'),
                        'desc_tip'          => true,
                        'type'              => 'number',
                        'value'             => $from_price,
                        'placeholder'       => '5.00',
                        'custom_attributes' => ['step' => '0.01', 'min' => '0'],
                    ]);
                    ?>

                    <?php if ($product_id && $host): ?>
                    <p class="form-field">
                        <label>&nbsp;</label>
                        <a href="<?php echo esc_url($host . '/app/widget/products'); ?>" target="_blank" class="button">
                            <?php esc_html_e('View in PrintLay', 'printlay-woocommerce'); ?> &rarr;
                        </a>
                    </p>
                    <?php endif; ?>
                </div>
            <?php endif; ?>
        </div>

        <script>
        jQuery(function($) {
            var $check = $('#_printlay_enabled');
            var $fields = $('.printlay-linked-fields');
            var $select = $('#_printlay_product_id');
            var currentVal = '<?php echo esc_js($product_id); ?>';
            var loaded = false;

            function loadProducts() {
                if (loaded) return;
                loaded = true;
                $select.html('<option value=""><?php esc_html_e('Loading...', 'printlay-woocommerce'); ?></option>');
                $.post(ajaxurl, {
                    action: 'printlay_fetch_products',
                    _wpnonce: '<?php echo wp_create_nonce('printlay_products'); ?>'
                }, function(res) {
                    $select.empty();
                    if (res.success && res.data && res.data.length) {
                        $select.append('<option value="">\u2014 Select a product \u2014</option>');
                        $.each(res.data, function(i, p) {
                            var sel = (p.id === currentVal) ? ' selected' : '';
                            $select.append('<option value="' + p.id + '"' + sel + '>' + p.name + ' (' + p.designer + ')</option>');
                        });
                    } else {
                        $select.append('<option value="">\u2014 No products found \u2014</option>');
                    }
                }).fail(function() {
                    $select.html('<option value="">\u2014 Failed to load \u2014</option>');
                    loaded = false;
                });
            }

            $check.on('change', function() {
                $fields.toggle(this.checked);
                if (this.checked) loadProducts();
            });

            // Load immediately if already enabled or on tab click
            if ($check.is(':checked')) {
                loadProducts();
            }
            $('a[href="#printlay_product_data"]').on('click', function() {
                if ($check.is(':checked')) loadProducts();
            });
        });
        </script>
        <?php
    }

    public function save_meta(int $post_id): void {
        if (!isset($_POST['_printlay_nonce']) || !wp_verify_nonce($_POST['_printlay_nonce'], 'printlay_save_meta')) {
            return;
        }
        if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) {
            return;
        }
        if (!current_user_can('edit_post', $post_id)) {
            return;
        }

        $enabled = isset($_POST['_printlay_enabled']) ? 'yes' : 'no';
        update_post_meta($post_id, '_printlay_enabled', $enabled);

        $product_id = sanitize_text_field($_POST['_printlay_product_id'] ?? '');
        update_post_meta($post_id, '_printlay_product_id', $product_id);

        $from_price = floatval($_POST['_printlay_from_price'] ?? 0);
        update_post_meta($post_id, '_printlay_from_price', $from_price > 0 ? $from_price : '');

        // Auto-set WooCommerce price so the product is purchasable and Google indexes it
        if ($enabled === 'yes' && $from_price > 0) {
            update_post_meta($post_id, '_regular_price', $from_price);
            update_post_meta($post_id, '_price', $from_price);
        }
    }

    public function ajax_fetch_products(): void {
        check_ajax_referer('printlay_products', '_wpnonce');
        if (!current_user_can('edit_products')) {
            wp_send_json_error('Permission denied');
        }

        $api = new PrintLay_API();
        $products = $api->list_products();

        if (is_wp_error($products)) {
            wp_send_json_error($products->get_error_message());
        }

        wp_send_json_success($products);
    }
}
