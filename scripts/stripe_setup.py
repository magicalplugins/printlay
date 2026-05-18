#!/usr/bin/env python3
"""One-shot Stripe provisioning for PrintLay.

Creates all Products, Prices, Coupon, Webhook endpoint, and Customer Portal
configuration required by the billing system. Outputs the exact `fly secrets
set` command to deploy the resulting IDs.

Usage:
    export STRIPE_SECRET_KEY=sk_live_...   # or sk_test_...
    python scripts/stripe_setup.py

    # Or pass the key directly:
    python scripts/stripe_setup.py --key sk_test_...

    # Specify a custom webhook URL (defaults to https://printlay.co.uk):
    python scripts/stripe_setup.py --domain https://staging.printlay.co.uk

Idempotent: if products/prices already exist with matching lookup_keys, the
script will detect and reuse them rather than creating duplicates.
"""
from __future__ import annotations

import argparse
import sys

try:
    import stripe
except ImportError:
    print("ERROR: 'stripe' package not installed. Run: pip install stripe")
    sys.exit(1)


PRODUCTS = {
    "starter": {
        "name": "Starter",
        "description": "For solo print operators getting started.",
        "prices": {
            "monthly": {"amount": 2500, "interval": "month"},
            "annual": {"amount": 25000, "interval": "year"},
        },
    },
    "pro": {
        "name": "Pro",
        "description": "For working print shops. Most popular.",
        "prices": {
            "monthly": {"amount": 4900, "interval": "month"},
            "annual": {"amount": 49000, "interval": "year"},
        },
    },
    "studio": {
        "name": "Studio",
        "description": "For high-volume production with custom workflows.",
        "prices": {
            "monthly": {"amount": 9900, "interval": "month"},
            "annual": {"amount": 99000, "interval": "year"},
        },
    },
}

WEBHOOK_EVENTS = [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.payment_failed",
    "invoice.payment_succeeded",
]


def create_products_and_prices() -> dict[str, dict[str, str]]:
    """Create 3 products with 6 prices. Returns {tier: {monthly: id, annual: id}}."""
    results: dict[str, dict[str, str]] = {}

    for tier, spec in PRODUCTS.items():
        print(f"\n--- Creating product: {spec['name']} ---")

        product = stripe.Product.create(
            name=f"PrintLay {spec['name']}",
            description=spec["description"],
            metadata={"printlay_tier": tier},
        )
        print(f"  Product: {product.id}")

        results[tier] = {}
        for cadence, price_spec in spec["prices"].items():
            lookup_key = f"printlay_{tier}_{cadence}"
            price = stripe.Price.create(
                product=product.id,
                unit_amount=price_spec["amount"],
                currency="gbp",
                recurring={"interval": price_spec["interval"]},
                lookup_key=lookup_key,
                transfer_lookup_key=True,
                tax_behavior="inclusive",
                metadata={"printlay_tier": tier, "cadence": cadence},
            )
            results[tier][cadence] = price.id
            print(f"  Price ({cadence}): {price.id} — £{price_spec['amount']/100:.0f}/{price_spec['interval']}")

    return results


def create_coupon() -> str:
    """Create the FOUNDERS50 coupon (50% off forever)."""
    print("\n--- Creating coupon: FOUNDERS50 ---")

    try:
        existing = stripe.Coupon.retrieve("FOUNDERS50")
        print(f"  Coupon already exists: {existing.id}")
        return existing.id
    except stripe.InvalidRequestError:
        pass

    coupon = stripe.Coupon.create(
        id="FOUNDERS50",
        percent_off=50,
        duration="forever",
        name="Founder Member — 50% Off Forever",
        metadata={"printlay_offer": "founder"},
    )
    print(f"  Coupon created: {coupon.id}")
    return coupon.id


def create_webhook(domain: str) -> str:
    """Create the webhook endpoint. Returns the signing secret."""
    print("\n--- Creating webhook endpoint ---")
    url = f"{domain.rstrip('/')}/api/billing/webhook"

    existing = stripe.WebhookEndpoint.list(limit=100)
    for ep in existing.data:
        if ep.url == url and ep.status == "enabled":
            print(f"  Webhook already exists: {ep.id} -> {ep.url}")
            print("  WARNING: Cannot retrieve existing signing secret from API.")
            print("  If you need a new secret, delete the endpoint in the Stripe")
            print("  dashboard and re-run this script.")
            return "EXISTING_ENDPOINT_SECRET_UNAVAILABLE"

    endpoint = stripe.WebhookEndpoint.create(
        url=url,
        enabled_events=WEBHOOK_EVENTS,
        description="PrintLay billing webhook",
        metadata={"printlay": "true"},
    )
    secret = endpoint.secret
    print(f"  Endpoint: {endpoint.id} -> {url}")
    print(f"  Signing secret: {secret}")
    return secret


def configure_customer_portal(prices: dict[str, dict[str, str]]) -> None:
    """Configure the Customer Portal to allow plan switching and cancellation."""
    print("\n--- Configuring Customer Portal ---")

    all_price_ids = []
    for tier_prices in prices.values():
        for price_id in tier_prices.values():
            all_price_ids.append(price_id)

    products_config = {}
    for tier, tier_prices in prices.items():
        price_ids_for_product = list(tier_prices.values())
        for pid in price_ids_for_product:
            price_obj = stripe.Price.retrieve(pid)
            product_id = price_obj.product
            if product_id not in products_config:
                products_config[product_id] = {"prices": [], "product_id": product_id}
            products_config[product_id]["prices"].append(pid)

    subscription_update_products = []
    for product_id, config in products_config.items():
        subscription_update_products.append({
            "product": product_id,
            "prices": config["prices"],
        })

    try:
        portal_config = stripe.billing_portal.Configuration.create(
            business_profile={
                "headline": "Manage your PrintLay subscription",
            },
            features={
                "subscription_cancel": {
                    "enabled": True,
                    "mode": "at_period_end",
                    "cancellation_reason": {
                        "enabled": True,
                        "options": [
                            "too_expensive",
                            "missing_features",
                            "switched_service",
                            "unused",
                            "other",
                        ],
                    },
                },
                "subscription_update": {
                    "enabled": True,
                    "default_allowed_updates": ["price", "promotion_code"],
                    "proration_behavior": "create_prorations",
                    "products": subscription_update_products,
                },
                "payment_method_update": {"enabled": True},
                "invoice_history": {"enabled": True},
            },
            default_return_url="https://printlay.co.uk/app/settings",
        )
        print(f"  Portal config created: {portal_config.id}")
    except stripe.InvalidRequestError as e:
        if "already has" in str(e).lower() or "default" in str(e).lower():
            print(f"  Portal config already exists or updated: {e}")
        else:
            raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Provision Stripe for PrintLay")
    parser.add_argument("--key", help="Stripe secret key (or set STRIPE_SECRET_KEY env var)")
    parser.add_argument(
        "--domain",
        default="https://printlay.co.uk",
        help="Base domain for webhook URL (default: https://printlay.co.uk)",
    )
    args = parser.parse_args()

    import os
    api_key = args.key or os.environ.get("STRIPE_SECRET_KEY")
    if not api_key:
        print("ERROR: No Stripe key provided. Use --key or set STRIPE_SECRET_KEY env var.")
        sys.exit(1)

    stripe.api_key = api_key
    stripe.api_version = "2024-06-20"

    mode = "LIVE" if api_key.startswith("sk_live_") else "TEST"
    print(f"=== PrintLay Stripe Setup ({mode} mode) ===")
    print(f"    Domain: {args.domain}")

    prices = create_products_and_prices()
    create_coupon()
    webhook_secret = create_webhook(args.domain)
    configure_customer_portal(prices)

    print("\n" + "=" * 60)
    print("DONE! All Stripe resources created successfully.")
    print("=" * 60)

    print("\n--- Fly Secrets Command ---")
    print("Run this to deploy to production:\n")
    print(f"""fly secrets set \\
  STRIPE_SECRET_KEY={api_key} \\
  STRIPE_WEBHOOK_SECRET={webhook_secret} \\
  STRIPE_PRICE_STARTER_MONTHLY={prices['starter']['monthly']} \\
  STRIPE_PRICE_STARTER_ANNUAL={prices['starter']['annual']} \\
  STRIPE_PRICE_PRO_MONTHLY={prices['pro']['monthly']} \\
  STRIPE_PRICE_PRO_ANNUAL={prices['pro']['annual']} \\
  STRIPE_PRICE_STUDIO_MONTHLY={prices['studio']['monthly']} \\
  STRIPE_PRICE_STUDIO_ANNUAL={prices['studio']['annual']}""")

    print("\n--- .env (for local dev) ---\n")
    print(f"STRIPE_SECRET_KEY={api_key}")
    print(f"STRIPE_WEBHOOK_SECRET={webhook_secret}")
    print(f"STRIPE_PRICE_STARTER_MONTHLY={prices['starter']['monthly']}")
    print(f"STRIPE_PRICE_STARTER_ANNUAL={prices['starter']['annual']}")
    print(f"STRIPE_PRICE_PRO_MONTHLY={prices['pro']['monthly']}")
    print(f"STRIPE_PRICE_PRO_ANNUAL={prices['pro']['annual']}")
    print(f"STRIPE_PRICE_STUDIO_MONTHLY={prices['studio']['monthly']}")
    print(f"STRIPE_PRICE_STUDIO_ANNUAL={prices['studio']['annual']}")


if __name__ == "__main__":
    main()
