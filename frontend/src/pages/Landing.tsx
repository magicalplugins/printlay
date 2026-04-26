import Hero from "../components/landing/Hero";
import KineticSteps from "../components/landing/KineticSteps";
import DemoClip from "../components/landing/DemoClip";
import PricingPreview from "../components/landing/PricingPreview";
import SignupBlock from "../components/landing/SignupBlock";
import LandingNav from "../components/landing/LandingNav";
import LandingFooter from "../components/landing/LandingFooter";

export default function Landing() {
  return (
    <div className="min-h-full">
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
