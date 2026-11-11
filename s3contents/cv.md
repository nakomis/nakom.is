<h1 style="text-align:center">Martin Harris</h1>

<p style="text-align:center;font-size:10.5pt;color:#555;margin:-4px 0 8px">Senior Backend Engineer &nbsp;·&nbsp; Distributed Systems &nbsp;·&nbsp; Edinburgh, UK</p>

<p style="text-align:center;font-size:10pt;color:#333;margin:0 0 4px"><a href="mailto:cv@nakomis.com">cv@nakomis.com</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="tel:+441312125959">+44 1312 125 959</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://cv.nakomis.com">cv.nakomis.com</a>&thinsp;<a href="https://github.com/nakomis" title="GitHub profile"><svg xmlns="http://www.w3.org/2000/svg" height="13" viewBox="0 0 16 16" style="vertical-align:middle;fill:#333;margin-left:4px"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a>&thinsp;<a href="https://www.linkedin.com/in/nakomis" title="LinkedIn profile"><svg xmlns="http://www.w3.org/2000/svg" height="13" viewBox="0 0 24 24" style="vertical-align:middle;fill:#0077b5;margin-left:3px"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg></a></p>

---

## Professional Summary

Senior backend engineer with deep experience building and operating distributed systems across cloud-native and on-premises environments. Primary backend stack is JVM (Java, Kotlin), with extensive TypeScript across frontend, IaC, and serverless surfaces. Strong background in AWS, cloud orchestration, and event-driven architectures. Recent work spans regulated financial-services platforms and large consumer-facing loyalty systems. Apache Software Foundation committer (Apache Brooklyn).

---

## Skills

**Backend & Distributed Systems:** Microservices, event-driven architecture, REST APIs, gRPC, OIDC/OAuth, cloud orchestration, message-driven systems

**Languages:** Java, Kotlin, TypeScript / Node.js, Python, Go, Bash

**Cloud & Infrastructure:** AWS (CDK, EKS, Lambda, API Gateway, EventBridge, DynamoDB, S3, CloudFront, IoT Core, Cognito, SageMaker), Google Cloud, Microsoft Azure, Terraform, CloudFormation, Kubernetes, Docker

**Frameworks & Tools:** Spring Boot, Next.js, React, Jenkins, Drone CI, Datadog

**AI & Machine Learning:** LLM APIs (Anthropic, OpenAI, Google), AWS Bedrock, AWS SageMaker (custom training pipelines, serverless inference), TensorFlow / MobileNet fine-tuning

**Databases:** PostgreSQL, MySQL, MongoDB, DynamoDB, MS SQL Server

---

## Professional Experience

### Senior Software Engineer
**Test Driven Solutions Ltd** · Edinburgh, UK · *November 2023 – Present*

Consulting engineer delivering core backend systems for enterprise clients across financial services, consumer rewards, media, and construction services.

- **Cloud-native clearing-and-custody platform** *(January 2026 – Present)* — Backend engineer on a regulated financial-infrastructure platform serving 900+ institutional clients (hedge funds, asset managers, broker-dealers) that collectively reach over 40 million end users globally. Building Java/gRPC microservices behind a TypeScript (Next.js) front end on Kubernetes with PostgreSQL and Datadog. Shipped a real-time chat interface backed by those services for order placement, position management, and market-data / news retrieval, alongside multi-leg options strategy tooling and on-demand market commentary. Stack: Java, Spring Boot, gRPC, TypeScript (Next.js), Kubernetes, Datadog, PostgreSQL.

- **Consumer loyalty and rewards platform** *(October 2024 – December 2025)* — Backend engineer on a unified loyalty platform reaching roughly 35 million customers across a multinational consumer-brand group. Designed and built a third-party API integration framework that consolidated multiple partner integrations behind a single contract, including a booking.com v3 endpoint for transaction-based earning. Delivered a marketing-campaign system on AWS EventBridge and an activity-based earn engine. Stack: Java, Spring Boot, Python, TypeScript, AWS (EventBridge, Lambda, RDS), Terraform, Drone CI.

- **Fire protection and construction services company** *(June 2024 – October 2024)* — Migrated the client's Android build pipeline and Play Store hosting in-house for a UK-wide field workforce of 100+ engineers, and updated the Kotlin codebase for compliance. Cut handset-to-server sync time from 5–10 minutes to around 20 seconds by collapsing 1,000+ per-record HTTPS calls into a single batched request. Stack: Kotlin, Android, VB.NET, SQL Server.

- **Major UK public broadcaster** *(December 2023 – June 2024)* — Contributed to the identity-platform migration (IDMv1 → IDMv2) underpinning tens of millions of UK accounts, in an agile squad focused on GDPR-compliant under-13 registration flows. Designed and built a reusable WebSocket-based primitive that replaced long-polling for "wait for an external event" flows across the platform; email verification was the first consumer, and the primitive was merged for reuse across the rest of the roadmap. Stack: Java, Spring Boot, AWS CDK, DynamoDB, PostgreSQL, WebSockets API Gateway.

### Lead Software Engineer
**Cloudsoft Corp Ltd** · Edinburgh, UK · *2012 – 2023*

- Lead engineer for cloud orchestration software, with several hundred commits to **Apache Brooklyn** (Apache Software Foundation committer) — an open-source framework for modelling, deploying, and managing distributed applications across cloud and on-premises environments.
- Architected and delivered core-product cloud orchestration software and customer-specific integrations via Cloudsoft's AMP platform, working directly with enterprise clients on deployments across AWS, Azure, Google Cloud, and on-premises infrastructure.
- Worked across Java, JavaScript (React), Python, Go, Docker, Kubernetes, Terraform, MySQL, and MongoDB; mentored a team of three engineers.

### Senior Product Designer / Programmer
**Supply Chain Systems / AgriWise** · Norwich / California · *May 2004 – March 2012*

- Designed and built a .NET software platform for real-time tracking and reporting of supply chain events across fresh-produce supply chains in the UK and the Americas.
- Owned the full architecture of the AgriWise platform, integrating bespoke handheld data-capture devices at farms and packhouses with a centralised reporting system.
- Relocated to California in 2006 to lead US market research and adapt the platform for grower-based organisations on the West Coast.

---

## Education

### University of East Anglia, Norwich · *1994–1996*
Certificate of Higher Education — Mathematics

---

## Open Source & Projects

### Apache Brooklyn
Apache Software Foundation committer on Apache Brooklyn, an open-source framework for modelling, deploying, and managing distributed applications across cloud and on-premises environments. Multi-year contributor.

### nakom.is
Personal website, URL shortener, and technical portfolio built on AWS CDK: serverless AI chat (Anthropic Claude with tool use), automated PDF CV generation (Chromium on Lambda), SSE streaming, React SPA, and multi-domain CloudFront distribution. Open source under CC0.
[github.com/nakomis/nakom.is](https://github.com/nakomis/nakom.is)

### BootBoots
A home cat-monitoring system built on a custom-designed PCB and 3D-printed enclosure, with firmware in embedded C++. Uses a MobileNet v2 model fine-tuned on labelled cat-camera footage via a custom SageMaker training pipeline (not an off-the-shelf model), deployed to a SageMaker serverless inference endpoint. A spray deterrent fires when the neighbour's cat is detected. Connectivity via Bluetooth and MQTT to AWS IoT Core; mobile app authentication via AWS Cognito. Infrastructure managed with AWS CDK.

---

<p style="font-size:9pt;color:#999;margin-top:14px">Nationality: British &nbsp;·&nbsp; Last updated: May 2026</p>
