// Curated "what this assistant is about" exemplars for the CV chatbot's on-topic
// relevance gate (NAKO-34). These sentences densely cover what the nakom.is
// social-app bot should answer: Martin's professional background, his public
// sources (CV, LinkedIn, GitHub, blog), the things he writes about / makes, and
// the cats. At build time they're embedded with Titan (see
// scripts/generate-topic-vectors.ts) into topic-vectors.json; at request time the
// user's query is embedded and cosine-compared against them. A query that isn't
// close to ANY of these is treated as off-topic.
//
// SOURCE OF TRUTH — edit these sentences, then run `npm run gen:topic-vectors`
// to regenerate topic-vectors.json, and commit both. The generator REJECTS
// duplicates, so each line must be unique. Aim for breadth over depth, and phrase
// every line in personal framing ("your", "you", "Martin") so the vector space
// leans toward questions ABOUT Martin — that's what keeps a generic "what is
// Kubernetes?" out while "what's your Kubernetes experience?" gets in.
export const TOPIC_EXEMPLARS: string[] = [
    // Identity / summary
    'Who is Martin Harris?',
    'Tell me about your background.',
    'What kind of engineer are you?',
    'Where are you based?',
    'Give me a summary of your career.',
    'What do you do for a living?',

    // Current role & recent experience
    "What's your current role?",
    'Who do you work for at the moment?',
    'Tell me about your work on the clearing-and-custody platform.',
    'Have you worked in financial services?',
    'What did you build on the consumer loyalty and rewards platform?',
    'What did you do at Cloudsoft?',
    'Tell me about your work on the BBC identity platform.',
    'What did you build for the fire-protection field workforce?',
    'How many years of backend experience do you have?',

    // Skills / tech
    "What's your experience with AWS?",
    'Do you know Kotlin?',
    'Have you used Kubernetes?',
    'What backend languages do you work in?',
    'Do you have experience with event-driven architecture?',
    'Have you worked with gRPC?',
    'What infrastructure-as-code tools have you used?',
    'Tell me about your machine-learning experience.',
    'Do you work with Java and Spring Boot?',
    'How much TypeScript and React have you done?',
    'What databases have you worked with?',

    // Hiring / availability / contact / job offers (feeds the [REQUEST_EMAIL] flow)
    'Are you available for hire?',
    'Are you open to contract work?',
    'How can I contact you?',
    'Can I get a copy of your CV?',
    'What are you looking for in a role?',
    "I'd like to offer you a job.",
    'I have a role that might suit you.',
    'Can I hire you for a project?',
    'How do I reach you about a job opportunity?',
    'Can I leave my email so you can get in touch?',

    // Education
    'What did you study?',
    'Where did you go to university?',

    // Public sources — GitHub
    "What's on your GitHub?",
    'Show me your GitHub projects.',
    'What repositories do you have?',
    'Link me your GitHub profile.',

    // Public sources — LinkedIn
    "What's your LinkedIn?",
    'Are you on LinkedIn?',
    'Link me your LinkedIn profile.',

    // Public sources — the blog
    'Do you have a blog?',
    "What's your blog about?",
    'Where can I read your blog?',
    'What do you write about on blog.nakomis.com?',

    // Blog topics / interests — AI, LLMs, RAG
    'Have you written about LLMs and AWS Bedrock?',
    'Tell me about your semantic search and RAG work.',
    'What did you write about giving Claude a persistent memory?',
    'Tell me about the MCP tools you have built.',

    // Blog topics / interests — ML & computer vision
    'How did you train your cat recogniser?',
    'Tell me about your machine-learning blog posts.',
    'Have you used SageMaker, TensorFlow or PyTorch?',

    // Blog topics / interests — home lab & infrastructure
    'Tell me about your home lab.',
    'What servers do you run at home?',
    'Tell me about your NAS, RAID and Samba setup.',
    'What Raspberry Pi projects have you built?',

    // Blog topics / interests — embedded & hardware
    'Tell me about your ESP32 and MQTT projects.',
    'What is the microcontroller that signs its own AWS requests?',
    'Tell me about your oscilloscope project, nakoscope.',

    // Blog topics / interests — Rust, making, 3D printing
    'What Rust projects have you worked on?',
    'Tell me about your egui Rust thermostat dial.',
    'What 3D-printing and CAD work have you done?',

    // Open source
    'What is Apache Brooklyn and what did you contribute?',
    'Are you an open-source contributor?',
    'Tell me about the nakom.is project.',

    // The cats (explicitly on-topic — the bot is a self-described "cat dad")
    'What cats do you have?',
    'Tell me about your cats.',
    'What type of cat is Mu?',
    'Who are Boots, Chi, Tau and Kappa?',
    'What is BootBoots, your cat-monitoring system?',
    'Tell me about the cat with the spray deterrent.',
];
