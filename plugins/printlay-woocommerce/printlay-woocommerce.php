<?php
/**
 * Plugin Name: PrintLay WooCommerce
 * Plugin URI: https://printlay.co.uk
 * Description: Integrates the PrintLay custom sticker designer into WooCommerce product pages.
 * Version: 1.0.0
 * Author: PrintLay
 * Author URI: https://printlay.co.uk
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * WC requires at least: 7.0
 * License: GPL-2.0-or-later
 * Text Domain: printlay-woocommerce
 */

defined('ABSPATH') || exit;

define('PRINTLAY_WC_VERSION', '1.0.0');
define('PRINTLAY_WC_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('PRINTLAY_WC_PLUGIN_URL', plugin_dir_url(__FILE__));
define('PRINTLAY_WC_BASENAME', plugin_basename(__FILE__));

final class PrintLay_WooCommerce {

    private static ?self $instance = null;

    public static function instance(): self {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        $this->includes();
        $this->init_hooks();
    }

    private function includes(): void {
        require_once PRINTLAY_WC_PLUGIN_DIR . 'includes/class-printlay-api.php';
        require_once PRINTLAY_WC_PLUGIN_DIR . 'includes/class-printlay-settings.php';
        require_once PRINTLAY_WC_PLUGIN_DIR . 'includes/class-printlay-product.php';
        require_once PRINTLAY_WC_PLUGIN_DIR . 'includes/class-printlay-frontend.php';
        require_once PRINTLAY_WC_PLUGIN_DIR . 'includes/class-printlay-cart.php';
    }

    private function init_hooks(): void {
        add_action('plugins_loaded', [$this, 'check_woocommerce']);
        add_action('init', [$this, 'load_textdomain']);
    }

    public function check_woocommerce(): void {
        if (!class_exists('WooCommerce')) {
            add_action('admin_notices', function () {
                echo '<div class="notice notice-error"><p>';
                esc_html_e('PrintLay WooCommerce requires WooCommerce to be installed and active.', 'printlay-woocommerce');
                echo '</p></div>';
            });
            return;
        }

        PrintLay_Settings::instance();
        PrintLay_Product::instance();
        PrintLay_Frontend::instance();
        PrintLay_Cart::instance();
    }

    public function load_textdomain(): void {
        load_plugin_textdomain('printlay-woocommerce', false, dirname(PRINTLAY_WC_BASENAME) . '/languages');
    }
}

function printlay_wc(): PrintLay_WooCommerce {
    return PrintLay_WooCommerce::instance();
}

printlay_wc();
