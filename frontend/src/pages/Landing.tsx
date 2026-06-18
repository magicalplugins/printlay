import Hero from "../components/landing/Hero";
import KineticSteps from "../components/landing/KineticSteps";
import DemoClip from "../components/landing/DemoClip";
import PricingPreview from "../components/landing/PricingPreview";
import SignupBlock from "../components/landing/SignupBlock";
import LandingNav from "../components/landing/LandingNav";
import LandingFooter from "../components/landing/LandingFooter";
import Seo from "../components/Seo";

export default function Landing() {
  return (
    <div className="min-h-full">
      <Seo
        title="Gang Sheet Builder & Print Imposition Software — Printlay"
        description="Printlay turns artwork into print-ready PDFs in four moves — build gang sheets, set slot order, fill from your catalogue, and export with bleed & cut lines."
        path="/"
        jsonLd={{
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "Printlay",
          applicationCategory: "BusinessApplication",
          operatingSystem: "Web",
          description:
            "Gang sheet builder and print imposition software for print shops. Upload or generate a template, program slot order, fill from your asset catalogue, and export a print-ready PDF with bleed and cut lines.",
          url: "https://printlay.co.uk/",
          offers: { "@type": "Offer", category: "subscription" },
        }}
      />
      <LandingNav />
      <Hero />
      <KineticSteps />
      <DemoClip />
      <PricingPreview />
      <SignupBlock />
      <LandingFooter />
    </div>
  );
}
