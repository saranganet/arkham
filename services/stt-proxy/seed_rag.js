import dotenv from 'dotenv';
import { addChunk } from './rag.js';

// Load environment variables
dotenv.config();

const PLAYBOOK_FACTS = {
  newtonschool: [
    {
      category: "FEES",
      text: "Fees & Financing: Course price 2.25L. NSDC Interview + Test scholarship brings price down to 1.85L. EMI options up to 36 months starting at 6500/month. No payment in month 1 (e.g. start January, pay February)."
    },
    {
      category: "PLACEMENT",
      text: "Placement Objections: Newton School provides mentorship and grooming. Student must commit 3-4 hours per day. If someone claims lifetime support is a scam, cite Subhadip Das (got 1st and 2nd jobs via Newton School). Placements: Potential salary 25 LPA+ packages; MNC partners include Amazon, Flipkart, Meesho, IBM. 1:1 expert doubt support is available."
    },
    {
      category: "DEGREE",
      text: "Degree Affiliation: Rishihood UGC B.Tech CS & AI is fully UGC-accredited via Rishihood University degree affiliation."
    },
    {
      category: "COMPETITOR",
      text: "Competitor Objections (Simplilearn, Intellipaat, or Cheaper 60k courses): Highlight instructor quality (Google/Amazon experts), lifetime placement support (Subhadip Das case), and company-specific grooming sessions before interview rounds. If competitor is expensive, compare USPs directly to show value. If competitor is aligned, connect with similar alum for trust."
    },
    {
      category: "BUY_SIGNAL",
      text: "Next Steps Closes: Free 45-min aptitude test (logical, English, no prep) to determine scholarship; or career counseling session (no purchase commitment)."
    },
    {
      category: "INQUIRY",
      text: "Base Pitch & Curriculum: Excel, SQL, Python, ML. Doubt support: 1:1 sessions with subject experts. Referral pool after 4 months (grooming, resume optimization). MWF 9 pm - 11 pm live classes."
    },
    {
      category: "SWITCHING",
      text: "Career Switch & Govt Job Prep: Govt job prep has cv gap risks and limited options if it fails. Switch to corporate data side now. Compare LPA/CTC trajectories."
    }
  ],
  saas: [
    {
      category: "BUDGET",
      text: "Budget/Pricing: Handle price objections via ROI. Acknowledge and redirect to cost-efficiencies. Explain value metrics and payback period."
    },
    {
      category: "TIMELINE",
      text: "Timeline/Onboarding: Guarantee rapid onboarding. We handle all migration and setup onboarding in less than 2 weeks."
    },
    {
      category: "SWITCHING",
      text: "Switching Friction & Value Selling: Explain ease of deployment, security standards (SOC2, GDPR compliance), integration flexibility, and long-term cost efficiencies."
    },
    {
      category: "COMPETITOR",
      text: "Competitor Objections: Salesforce (takes 6 months, cost double; we go live in 2 weeks), HubSpot (user-friendly but custom object limits scale block), Zoho (highly custom but setup friction)."
    },
    {
      category: "BUY_SIGNAL",
      text: "Next Steps: Book a 15-minute setup call next Tuesday to configure your workspace sandbox and review features."
    }
  ],
  insurance: [
    {
      category: "BUDGET",
      text: "Budget/Pricing: Acknowledge rate concerns and redirect to custom coverage, deductibles adjustment, and long-term stability. Offer bundling discounts (auto + home + life)."
    },
    {
      category: "TIMELINE",
      text: "Timeline & Switching: Effortless switching assistance. Guarantee quick response time. We handle carrier migrations."
    },
    {
      category: "SWITCHING",
      text: "Switching Friction: Effortless switching assistance. Highlight the cost of being underinsured or having coverage gaps."
    },
    {
      category: "COMPETITOR",
      text: "Competitor: Effortless switching assistance. Compare rates, deductibles, coverage benefits, and stability ratings."
    },
    {
      category: "BUY_SIGNAL",
      text: "Next Steps: Book a free quote review or schedule a follow-up call with a senior broker."
    }
  ],
  realestate: [
    {
      category: "BUDGET",
      text: "Budget/Pricing & Rates: Marry the house and refinance the rate later. Secure the property price today. Address interest rate anxiety by focusing on equity building."
    },
    {
      category: "TIMELINE",
      text: "Timeline/Fit: Highlight localized neighborhood growth trends, neighborhood fit, inspection findings, and long-term appreciation."
    },
    {
      category: "SWITCHING",
      text: "Switching Friction: Highlight appreciation of current vs new property. Address equity building and long-term growth differences."
    },
    {
      category: "COMPETITOR",
      text: "Competitor: Highlight localized neighborhood growth trends, building equity, appreciation, and localized developer quality."
    },
    {
      category: "BUY_SIGNAL",
      text: "Next Steps: Book home tour, schedule site visit, or schedule meeting with financial advisor."
    }
  ],
  hearthline: [
    {
      category: "CLIENT_PROFILE",
      text: "Company Context: Hearthline is a 300-person DTC home goods brand selling premium sleep, kitchen, and small-space living products through Shopify, paid social, lifecycle email, and a growing wholesale channel. The company is trying to prove its second-category launch can scale without letting CAC erase contribution margin."
    },
    {
      category: "CLIENT_PROFILE",
      text: "Current Workflow: The client owns brand, performance, content, and CX across a 30-person team at a 300-person DTC company. Lives in HubSpot, GA4, Northbeam, and the Shopify backend. Weekly merchandising review with the head of product, daily standup with paid media, monthly board prep. Half her week is roadmap, half is putting out fires."
    }
  ]
};

async function seed() {
  console.log("=== STARTING VECTOR SEEDING PROCESS ===");
  let totalSeeded = 0;
  
  try {
    for (const [playbook, facts] of Object.entries(PLAYBOOK_FACTS)) {
      console.log(`\nProcessing playbook: "${playbook}"...`);
      for (const fact of facts) {
        console.log(`  -> Vectorizing [${fact.category}]: "${fact.text.substring(0, 50)}..."`);
        await addChunk(fact.text, {
          playbook,
          category: fact.category
        });
        totalSeeded++;
      }
    }
    console.log(`\n✓ Seeding complete! Seeded ${totalSeeded} chunks successfully.`);
  } catch (err) {
    console.error("✗ Seeding failed:", err.message);
  }
}

seed();
