import Hero from "../components/landing/Hero";
import KineticSteps from "../components/landing/KineticSteps";
import DemoClip from "../components/landing/DemoClip";
import SignupBlock from "../components/landing/SignupBlock";

export default function Landing() {
  return (
    <div className="min-h-full">
      <Hero />
      <KineticSteps />
      <DemoClip />
      <SignupBlock />
      <footer className="px-6 py-10 border-t border-neutral-900 text-center text-xs text-neutral-500">
        Printlay · Built for print shops who gang up sheets · {new Date().getFullYear()}
      </footer>
    </div>
  );
}
