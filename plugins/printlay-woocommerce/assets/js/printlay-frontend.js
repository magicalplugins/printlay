/**
 * PrintLay WooCommerce Frontend
 *
 * Handles the designer overlay, session minting, postMessage listener,
 * and WooCommerce cart integration.
 */
(function ($) {
  "use strict";

  var overlay = document.getElementById("printlay-overlay");
  var iframe = document.getElementById("printlay-iframe");
  var loading = document.getElementById("printlay-loading");
  var openBtn = document.getElementById("printlay-open-designer");
  var closeBtn = document.getElementById("printlay-close-designer");

  if (!overlay || !iframe || !openBtn) return;

  var sessionToken = null;
  var isOpen = false;

  function openOverlay() {
    overlay.style.display = "flex";
    overlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    isOpen = true;

    if (!sessionToken) {
      mintSession();
    } else {
      showIframe();
    }
  }

  function closeOverlay() {
    overlay.style.display = "none";
    overlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    isOpen = false;
  }

  function mintSession() {
    loading.style.display = "flex";
    iframe.style.display = "none";

    $.post(printlayData.ajaxUrl, {
      action: "printlay_create_session",
      _wpnonce: printlayData.nonce,
      product_id: printlayData.productId,
      wc_product_id: printlayData.wcProductId,
    })
      .done(function (res) {
        if (res.success && res.data.session_token) {
          sessionToken = res.data.session_token;
          showIframe();
        } else {
          showError(res.data || printlayData.i18n.error);
        }
      })
      .fail(function () {
        showError(printlayData.i18n.error);
      });
  }

  function showIframe() {
    var src =
      printlayData.host +
      "/embed/sticker?token=" +
      encodeURIComponent(sessionToken);
    iframe.src = src;
    iframe.style.display = "block";
    loading.style.display = "none";

    iframe.onload = function () {
      loading.style.display = "none";
    };
  }

  function showError(msg) {
    loading.innerHTML =
      '<p style="color:#dc3232;font-weight:600;">' + msg + "</p>" +
      '<button type="button" class="printlay-btn" onclick="location.reload()">Try Again</button>';
  }

  // Listen for postMessage from PrintLay iframe
  window.addEventListener("message", function (event) {
    if (!isOpen) return;
    if (event.origin !== printlayData.host) return;

    var data = event.data;
    if (!data || data.type !== "printlay:add-to-cart") return;

    addToCart(data);
  });

  function addToCart(data) {
    loading.style.display = "flex";
    loading.innerHTML =
      '<div class="printlay-spinner"></div><p>' +
      printlayData.i18n.loading.replace("designer", "cart") +
      "</p>";
    iframe.style.display = "none";

    $.post(printlayData.ajaxUrl, {
      action: "printlay_add_to_cart",
      _wpnonce: printlayData.cartNonce,
      wc_product_id: printlayData.wcProductId,
      design_ref: data.design_ref || "",
      quote_token: data.quote_token || "",
      total: data.total || 0,
      currency: data.currency || "",
      quantity: data.quantity || 1,
      options: JSON.stringify(data.options || {}),
      thumbnail_url: data.thumbnail_url || "",
    })
      .done(function (res) {
        if (res.success) {
          showSuccess();
        } else {
          showError(res.data || "Failed to add to cart");
        }
      })
      .fail(function () {
        showError("Failed to add to cart. Please try again.");
      });
  }

  function showSuccess() {
    loading.style.display = "none";
    iframe.style.display = "none";
    overlay.querySelector(".printlay-overlay-body").innerHTML =
      '<div class="printlay-success">' +
      '<div class="printlay-success-icon">&#10003;</div>' +
      "<h3>" + printlayData.i18n.added + "</h3>" +
      "<p>Your custom sticker has been added to your cart.</p>" +
      '<div class="printlay-success-actions">' +
      '<a href="' + printlayData.cartUrl + '" class="printlay-btn printlay-btn-primary">View Cart</a>' +
      '<button type="button" class="printlay-btn" onclick="location.reload()">Continue Shopping</button>' +
      "</div>" +
      "</div>";
  }

  // Event bindings
  openBtn.addEventListener("click", openOverlay);
  closeBtn.addEventListener("click", closeOverlay);

  // Close on Escape key
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen) {
      closeOverlay();
    }
  });

  // Close on overlay backdrop click
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) {
      closeOverlay();
    }
  });
})(jQuery);
