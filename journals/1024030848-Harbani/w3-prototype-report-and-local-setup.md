# Week 3: Writing the Prototype Report, and Running SmartPrint on My Own Machine

Harbani Kaur
Roll No: 1024030848
14–20 September 2026

## 1 Context

Week 2 ended with all our work living in one big commit pushed from Ina's machine. This week
had two jobs. The first was writing the mid-semester (prototype-stage) report for UCS503
together. The second was getting the project running on *my* laptop from the shared
repository, not from my dead fork and not by borrowing Ina's setup. Until a project runs on a
second machine, it has only been proven to run on one.

## 2 The Prototype Report: Describing What Exists, Not What We Imagined

We co-wrote the prototype-stage report (`project-report-prototype-stage/main.tex`). It covers:
- the problem statement
- use-case diagrams and templates
- activity and swimlane diagrams
- DFDs (levels 0 to 2)
- an SRS with functional and non-functional requirements

The part that taught me the most was the use-case templates. We wrote eight of them, from
UC-01 Login to UC-08 Request Refund, each in actor / pre-condition / main flow / alternate
flow / post-condition format. The rule we held ourselves to was that each one had to match the
authorization rules and state transitions the backend *actually* enforces, not the ones we
sketched in Week 1.

That rule changed how I read a use case. Some examples of what it made us get right:

- **UC-04 Make Payment** isn't always triggered. A faculty order at the CSE faculty shop goes
  straight from UC-03 (Place Order) into the queue with no payment step at all. That's the
  "faculty print free" rule Ina spotted in our Week 1 survey, now a real branch in the flow.
- **UC-07 Cancel Order** and **UC-08 Request Refund** are linked: cancelling only leads to a
  refund when the order already had a successful payment.
- **UC-06 Manage Print Queue** is strictly FIFO, exactly as our senior advised in Week 1:
  no priority lanes, ordered by when the order entered the queue.

A use case written from memory describes the product you hoped for. A use case written from
the code describes the product you have, and the gap between the two becomes a to-do list.

## 3 Running the Project Locally

On 17 September I set up a local SmartPrint environment from the shared repository. PostgreSQL
runs in Docker (published on host port 5433), with the Prisma migrations applied to it and the
seed script providing a development account for each role. The migration history on my
database records all eight migrations being applied that day, in order, starting from
`20260902130600_init`.

The same day, Ina pushed a cleanup of the repo (see her Week 3 entry), and our Week 1–2
journals went in as pull requests #1 and #2. It was the first time either of us used the
pull-request flow on this repo instead of pushing straight to `main`.

## 4 Observation: Two "Defaults" for One Database

**What I noticed:** on 17 September, Ina changed `code/backend/.env.example` to point at a
native PostgreSQL on port **5432**, because 5433 collided with other Docker projects on her
machine. My own working setup, built the same day, uses the Docker Compose database on port
**5433**.

**Relevant context:** neither choice is wrong. Native Postgres on 5432 is the common default,
and the Compose file publishes the container on 5433 so it doesn't fight a native install. But
the repo now quietly supports two different setups, and `.env.example` only describes one.

**Key observation:** a configuration file is a promise to the next person who clones the repo.
When two teammates each have a setup that works for them, the example file ends up matching
whoever edited it last, and the other setup lives only in someone's head.

**What I'd do about it:** pick one documented default per environment (development, Docker,
test), and make every config file agree with it: `.env.example`, `docker-compose.yml` and
`vite.config.ts`.

**Because** "it works on my machine" is not one bug but a family of them. Each machine is
correct on its own, and the disagreement only shows up when someone new tries to start from
the docs.

## 5 Outcome

- Mid-semester prototype report written and committed: 8 use-case templates, DFDs 0–2, SRS.
- SmartPrint running end-to-end on my laptop, against my own local database.
- Journals for Weeks 1–2 submitted through pull requests.

## 6 Follow-ups

- Agree on a single port and setup story with Ina, so `.env.example`, Docker Compose and the
  Vite proxy all describe the same system.
- Re-read my Week 2 frontend scaffold against what the app now routes to. The report's
  frontend description (route guards, role-based pages) should be checked file by file, the
  same way we checked the use cases against the backend.
