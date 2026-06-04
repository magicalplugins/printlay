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
