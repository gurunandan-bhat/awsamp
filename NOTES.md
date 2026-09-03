# AWS Amplify Gen 2 — Learning Notes

Started: 2026-09-03
Working dir: /home/nandan/repos/awsamp
Learner: gbhat@pobox.com
AWS account: 566275025856 · Region: ap-south-1 (Mumbai) · CLI identity: IAM user `amplifier`

## Goal

Move from "Amplify for static hosting + vanilla JS" to building web apps that
integrate Cognito, API Gateway, Lambda, and DynamoDB — using the latest
Amplify Gen 2.

## Learning preferences (keep these in mind for every module)

- Start small: static site first, then layer features in.
- Learn in modules with well-defined goals and a clear "done when" check.
- Vanilla JavaScript over TypeScript wherever possible (frontend, build setup).
- **Lambda handlers in Go** (prior Go experience). Not critical, but preferred —
  affects how Module 03 is built (CDK Lambda construct, not `defineFunction`).
- Finish one capability fully before moving to the next.

## Key reality check: TypeScript in Amplify Gen 2

Amplify Gen 2 is "TypeScript-first" for the **backend definition** only. This is
unavoidable but small and declarative:

- `amplify/backend.ts`, `amplify/auth/resource.ts`, `amplify/data/resource.ts`,
  `amplify/functions/*/resource.ts` are `.ts` files. They *describe* resources;
  they are not where app logic lives.
- Everything you actually write as application code stays out of TS:
  - Frontend app code — **vanilla JS** (`index.html`, `app.js`, `fetch`,
    Amplify JS Auth APIs).
  - Lambda handler code — **Go** (`aws-lambda-go` + AWS SDK for Go v2). This
    means Module 03 does not use `defineFunction` (Node-only); the function is a
    CDK `lambda.Function` on the `provided.al2023` custom runtime, defined in
    `backend.ts` alongside the rest of the REST wiring.
- A bundler is still needed for the frontend to use the `aws-amplify` package.
  Plan: Vite "vanilla" template (no framework), or an ESM CDN for pure static.

## How this compares to AWS SAM (mental model)

I already ship apps that wire Cognito + API Gateway + Lambda + DynamoDB (plus
GitHub webhooks) together with plain **SAM** templates. Amplify Gen 2 is not
"SAM + extra glue" — it *replaces* the SAM authoring layer with the AWS CDK and
adds a full-stack framework on top.

| | SAM | Amplify Gen 2 |
|---|---|---|
| Author in | declarative YAML | imperative TypeScript (`amplify/*.ts`) |
| Intermediate | SAM transform = a CloudFormation macro; ~1:1 to resources | AWS CDK synthesizes CloudFormation (nested-stack tree) |
| Abstraction | thin (`Serverless::Function` ≈ Lambda + role + event) | thick (`defineData` ≈ whole AppSync API + tables + resolvers) |
| Scope | backend IaC only | full stack: also sandbox, branch deploys, `amplify_outputs.json`, `aws-amplify` client libs |
| Escape hatch | it's already low-level | drop to raw CDK in `backend.ts` (`backend.createStack()`, `backend.auth.resources.userPool`, …) |

Both still bottom out at CloudFormation. Amplify's `@aws-amplify/backend` is just
a set of opinionated CDK constructs.

**What is still my job (same as SAM):**
- **Lambda handler code** — always. Amplify provisions the function/role/runtime;
  the handler body is 100% mine (Go, for this project).
- **DynamoDB** — *on our chosen path*. Module 03 skips `defineData` and declares
  its own CDK `dynamodb.TableV2` (I pick PK/SK/GSIs/billing) and does all CRUD in
  the Go handler via the AWS SDK. Amplify only provisions the table + IAM grant.
  (The `defineData`/GraphQL path *would* create and own tables for me and
  generate resolvers — we're deliberately not using it.)

**Net:** Module 03's day-to-day will feel close to my SAM workflow — I own the
schema and the handler, the IaC just wires them. The deltas are: authoring in
CDK/TS instead of SAM YAML, and it deploys as one Amplify app alongside auth and
hosting. Real value of using Amplify here = the Cognito auth integration + client
libs, branch-based hosting, and auto-wired frontend config. For a pure API+DB
backend with none of that, SAM stays a valid choice.

## The files `npm create amplify@latest` generated

The `amplify/` folder is your **backend described as code**. Nothing in it runs
in your web app or on a server while users are using the site. It is read *once,
at deploy time*: the AWS CDK reads these files, turns them into a CloudFormation
template, and CloudFormation creates the real AWS resources. Treat these files as
a blueprint, not a program.

The full pipeline, for a first-time AWS user:

```
amplify/*.ts  --(CDK compiles)-->  CloudFormation template
              --(CloudFormation deploys)-->  real AWS resources (Cognito, DynamoDB, ...)
              --(ampx reads the results back)-->  amplify_outputs.json
              --(Amplify.configure)-->  your vanilla-JS frontend
```

### `amplify/backend.ts` — the assembly point

The first file `ampx` looks at. Its job is to collect every backend resource and
combine them into one deployable unit:

```ts
defineBackend({ auth, data });
```

Whatever you pass to `defineBackend` gets deployed; whatever you leave out does
not. This file is also where you will later:

- **reach into** a generated resource to adjust something the `define*` helper
  didn't expose (an "escape hatch" down to raw CDK / CloudFormation);
- **add resources that have no `define*` helper** — in Module 03 we create an API
  Gateway REST API, a DynamoDB table, and a Cognito authorizer here as CDK code
  against `backend.createStack(...)`;
- **publish values to the frontend** with `backend.addOutput({ custom: { ... } })`,
  which adds them to `amplify_outputs.json`.

Role in the final app: the manifest that ties everything together. By the end it
imports `auth` and a `defineFunction`, and contains CDK code building the REST
API + table + authorizer and wiring them to each other.

### `amplify/auth/resource.ts` — who can sign in

```ts
export const auth = defineAuth({ loginWith: { email: true } });
```

`defineAuth` is a helper that expands a few lines of config into a complete
Amazon Cognito setup:

- a **User Pool** — the directory of user accounts: usernames, passwords, email
  verification, password rules, optional MFA;
- a **User Pool Client** — the app's identifier for talking to that pool (think
  "which app is asking");
- an **Identity Pool** — exchanges a signed-in user's login token for *temporary
  AWS credentials*, and can also hand limited "guest" credentials to anonymous
  visitors.

`loginWith: { email: true }` means users sign in with email + password, and
Cognito emails a verification code at sign-up.

Role in the final app: this is Module 02. We'll extend it (required attributes,
the verification email, possibly user groups). In Module 03 the REST API's
authorizer points back at *this* User Pool, so any request without a valid token
issued here is rejected before it reaches our Lambda.

### `amplify/data/resource.ts` — the default data API (we will replace this)

```ts
export const data = defineData({ schema, authorizationModes: { ... } });
```

`a.schema({...})` describes your data as **models**. Each `a.model()` turns into:

- a **DynamoDB table**;
- a set of **GraphQL operations** (list / get / create / update / delete);
- **AppSync resolvers** — the generated glue that translates each GraphQL request
  into a DynamoDB call. You write no code for these.

The sample declares a `Todo` model with one `content` string and
`.authorization(allow => [allow.guest()])` — meaning anyone holding the app's
config can read and write it. Fine for a throwaway demo, not for anything real.
`defaultAuthorizationMode: 'identityPool'` ties access to the Identity Pool from
`auth`.

Role in the final app: **none — this is the part we swap out.** Our path uses a
REST API (API Gateway + Lambda + DynamoDB) instead of GraphQL/AppSync. In
Module 03 we delete this file (or empty its schema) and remove `data` from
`backend.ts`, and watch the sandbox tear the AppSync API and Todo table back
down. It's kept for now only because that teardown is itself instructive.

### Supporting files (not resource definitions)

- **`amplify/package.json`** — marks `amplify/` as its own small module; mainly
  `"type": "module"` so `import` / `export` work. Rarely touched.
- **`amplify/tsconfig.json`** — TypeScript settings for the backend files, so the
  editor type-checks them and `ampx` can compile them. Leave it alone.
- **root `package.json`** — the project's dependencies. Today: `@aws-amplify/backend`,
  `@aws-amplify/backend-cli`, `aws-cdk-lib`, `typescript`. Frontend deps
  (`aws-amplify`, Vite) get added here in later modules.
- **root `tsconfig.json`** — repo-wide TypeScript / editor settings.
- **`.gitignore`** — keeps `node_modules/`, `.amplify/`, and `amplify_outputs.json`
  out of git (`amplify_outputs.json` is regenerated per environment and holds
  environment-specific ids).

### Files that appear *after* a deploy (generated, not scaffolded)

- **`amplify_outputs.json`** (project root) — the bridge to the frontend. After
  every sandbox deploy `ampx` writes the real ids and endpoints here (User Pool
  id, client id, Identity Pool id, API URLs). The frontend passes this straight
  to `Amplify.configure(...)`. Never hand-edit it; don't assume the values
  survive a `sandbox delete`.
- **`.amplify/`** — local cache/metadata mapping this checkout to its sandbox
  stack. Safe to delete; regenerated on next `ampx` run.

## Adding more services later (e.g. SES, SNS, SQS, EventBridge)

The mental model: new stuff is declared under `amplify/` and wired through
`backend.ts`. How you declare it depends on the tier:

- **Tier 1 — the four categories with a `define*` helper** (`auth`, `data`,
  `function`, `storage`): subfolder + `resource.ts`, export it, import into
  `backend.ts`, add to `defineBackend({...})`. (What we've seen with `auth`/`data`.)
- **Tier 2 — everything else** (SES, SNS, SQS, EventBridge, a standalone DynamoDB
  table, API Gateway REST, Step Functions…): no helper — add them as **raw AWS
  CDK constructs**, either inline in `backend.ts` after
  `const backend = defineBackend({...})` (scope them with
  `backend.createStack('Name')`), or in your own file (e.g. `amplify/custom/x.ts`)
  that `backend.ts` calls.

Rule either way: **`backend.ts` is the single integration point** — a resource is
in the deployment only because `backend.ts` references it.

**SES is a light case** — not much infrastructure to provision:
- CDK-manageable bits are small: `ses.EmailIdentity` (verified sender),
  configuration set, receipt rules.
- Verification is partly out-of-band: a domain identity needs DNS records, a
  single address needs a confirmation click. CloudFormation makes the identity;
  you finish verifying by hand.
- A new SES account is in its own sandbox (send only to verified addresses,
  ~200/day) until you request production access via a support case — not an IaC step.
- Common patterns:
  1. **App emails from the Lambda** — don't "provision SES" at all: verify one
     sender once, grant the function `ses:SendEmail`, call it with the SDK.
  2. **Cognito emails via SES** — set on `defineAuth` (`senders.email`) or by
     overriding the underlying Cognito construct in `backend.ts`, pointed at a
     verified `fromEmail`.

## Toolchain / commands

- Scaffold: `npm create amplify@latest`
- Per-developer cloud sandbox (hot reload): `npx ampx sandbox`
- Tear down sandbox (do this to avoid leaving AWS resources): `npx ampx sandbox delete`
- Generate frontend config: produces `amplify_outputs.json`
  (Gen 1's `aws-exports.js` is gone.)
- Frontend wiring:
  `import { Amplify } from 'aws-amplify'; import outputs from './amplify_outputs.json'; Amplify.configure(outputs);`
- Prereqs: AWS account, AWS CLI configured with a profile (IAM Identity Center
  recommended), Node.js LTS.
- Hosting fullstack: connect a Git repo (GitHub/GitLab/Bitbucket) in the Amplify
  console; build controlled by `amplify.yml`. Local `ampx sandbox` needs no repo.

## Planned modules

### Module 0 — Setup
Goal: `npx ampx sandbox` deploys successfully; understand the `amplify/` folder
and that a CloudFormation stack was created.
Done when: sandbox is up, `amplify_outputs.json` exists, you can explain what deployed.

### Module 1 — Static site
Goal: minimal `index.html` + `app.js` + CSS, no framework, served locally; then
deployed via Amplify Hosting (needs a GitHub repo).
Done when: a public URL serves your static content and you understand the build pipeline.

### Module 2 — Auth with Cognito
Goal: `defineAuth({ loginWith: { email: true } })`; hand-built vanilla JS UI for
sign-up / confirm code / sign-in / sign-out using `aws-amplify/auth`
(`signUp`, `confirmSignUp`, `signIn`, `signOut`, `getCurrentUser`, `fetchAuthSession`).
Gate the Module 1 content behind login.
Done when: register → confirm email → sign in → see protected content → sign out.
Note: the drop-in Authenticator UI component is React/Vue/Angular only — we build ours.

### Module 3 — API Gateway + Lambda (Go) + DynamoDB (REST)
Goal: authenticated CRUD on a DynamoDB table, per-user scoped by Cognito `sub`.
All of this is CDK code in `backend.ts` — Gen 2 has no `defineRestApi`, and
`defineFunction` is Node-only so we skip it for a Go handler.
- **Lambda (Go):** CDK `lambda.Function`, `runtime: Runtime.PROVIDED_AL2023`,
  `architecture: ARM_64` (Graviton, cheaper). Handler source under
  `functions/api/` (`main.go`, `go.mod`). Two ways to build it:
  - `GoFunction` from `@aws-cdk/aws-lambda-go-alpha` — compiles on deploy
    (needs Go locally, or Docker bundling). Simplest; API is "alpha".
  - plain `lambda.Function` + `Code.fromAsset('functions/api/dist')` where a
    small build step produces `bootstrap`
    (`GOOS=linux GOARCH=arm64 go build -tags lambda.norpc -o bootstrap`).
  - Decide which when we get there; start with `GoFunction`.
- **Go handler deps:** `github.com/aws/aws-lambda-go/{lambda,events}`,
  `github.com/aws/aws-sdk-go-v2/...` (`config`, `service/dynamodb`,
  `feature/dynamodb/attributevalue`, `feature/dynamodb/expression`).
- **API + table:** CDK `RestApi` + `LambdaIntegration` +
  `CognitoUserPoolsAuthorizer(backend.auth.resources.userPool)`, plus a CDK
  `dynamodb.TableV2` (PK `userId`, SK `itemId`).
- `table.grantReadWriteData(fn)`; `fn.addEnvironment('TABLE_NAME', table.tableName)`.
- Expose the endpoint: `backend.addOutput({ custom: { API: { endpoint: api.url } } })`.
- **Frontend:** plain `fetch`, `Authorization: <idToken>` from
  `fetchAuthSession()` → `session.tokens.idToken.toString()`.
- **In the Go handler:** the caller's `sub` is in
  `event.RequestContext.Authorizer["claims"].(map[string]any)["sub"]`
  (from `events.APIGatewayProxyRequest`). Return `events.APIGatewayProxyResponse`.
Pitfalls: enable CORS (`defaultCorsPreflightOptions` on `RestApi` **and** return
`Access-Control-Allow-Origin` from the handler, error paths included). Go on
Lambda needs the custom runtime (`provided.al2*`) with a binary literally named
`bootstrap` — the AWS-managed `go1.x` runtime is retired.
Prereq for this module: Go toolchain installed locally (and maybe Docker).
Done when: a signed-in user can create/list/update/delete items stored in DynamoDB,
scoped to their account; unauthenticated calls get 401.

### Module 4 — Stretch (optional)
Custom domain, branch environments, CloudWatch logs / X-Ray, least-privilege IAM,
seed data, local unit tests for the Lambda, CI/CD via Amplify Hosting.

## Cost / hygiene

Sandbox provisions real resources (Cognito, Lambda, DynamoDB, API Gateway via
CloudFormation) — mostly free-tier friendly. Run `npx ampx sandbox delete` when
done for the day.

## Module 00 — Setup: what actually happened (2026-09-03)

### The steps we ran, and what each one did

1. **Configured AWS CLI credentials.** Local machine only — no AWS resources
   created. An IAM user `amplifier` with `AdministratorAccess` in account
   `566275025856`, default region `ap-south-1`. Verified with
   `aws sts get-caller-identity` (returns the account id + the user's ARN).

2. **`npm create amplify@latest`.** Local only. Generated the `amplify/` folder
   (`backend.ts`, `auth/resource.ts`, `data/resource.ts`), `package.json`,
   `tsconfig.json`, `.gitignore`, and ran `npm install`. Still nothing on AWS —
   these files only *describe* a backend.

3. **First `npx ampx sandbox` — failed:** "region ap-south-1 not bootstrapped".
   Amplify Gen 2 deploys through the AWS CDK, and the CDK needs a one-time
   "bootstrap" in each account + region before its very first deployment.

4. **CDK bootstrap — hit a wedged stack.** A `CDKToolkit` stack already existed
   in ap-south-1 from an earlier abandoned attempt, stuck in
   `UPDATE_ROLLBACK_FAILED`. CloudFormation will not modify a stack in a
   failed-rollback state, so bootstrap could not proceed.

5. **Deleted `CDKToolkit` via the CloudFormation console.** Removed the broken
   bootstrap stack and the resources it owned (a staging S3 bucket, a few IAM
   roles, an SSM parameter). Safe to do because nothing had been successfully
   deployed on top of it yet.

6. **Re-ran `npx aws-cdk bootstrap aws://566275025856/ap-south-1`.** Succeeded.
   Created a fresh `CDKToolkit` stack (see contents below).

7. **`npx ampx sandbox`.** Succeeded. Compiled `amplify/*.ts` → a CloudFormation
   template → deployed it as the sandbox stack, then wrote `amplify_outputs.json`
   to the project root. Terminal now sits on "watching for file changes" and
   redeploys on save. Leave it running while working.

### What a CloudFormation stack is, and why it was necessary

CloudFormation is AWS's infrastructure-as-code service. You hand it a
template (JSON/YAML) that lists a set of AWS resources; it creates them as one
unit called a **stack**, records every resource it made, and updates or deletes
them together. That gives you: reproducibility (same template → same infra),
atomic changes (a failed create rolls the whole stack back automatically), and
clean teardown (delete the stack → every resource it created goes with it).

Why it's in the picture here: Amplify Gen 2 never calls AWS service APIs
directly. The `amplify/*.ts` files are turned by the **AWS CDK** into a
CloudFormation template, and that template is deployed as a stack. So "deploy my
backend" literally means "CloudFormation create/update this stack". That is why
our setup snag showed up as a *stack state* (`UPDATE_ROLLBACK_FAILED`), and why
tearing the sandbox down is `ampx sandbox delete` (i.e. delete the stack).

### What "bootstrapping" is

Before the CDK can deploy anything into an account + region, it needs a little
infrastructure of its own: an S3 bucket to upload templates and assets to, an
ECR repository for container images, and a handful of IAM roles it assumes to
run deployments. `cdk bootstrap` creates all of that as a stack named
**`CDKToolkit`**. One-time per region. Our first `CDKToolkit` was broken, which
is what step 4–5 were about.

### Resources that now exist on AWS — account 566275025856, region ap-south-1

**Stack `CDKToolkit`** (from `cdk bootstrap`)
- S3 bucket `cdk-hnb659fds-assets-566275025856-ap-south-1` — deployment staging
- ECR repository `cdk-hnb659fds-container-assets-566275025856-ap-south-1`
- IAM roles `cdk-hnb659fds-{cfn-exec,deploy,file-publishing,image-publishing,lookup}-role-...`
- SSM parameter `/cdk-bootstrap/hnb659fds/version`
- Cost at rest: effectively $0 (near-empty bucket, empty ECR repo)

**Stack `amplify-awsamp-<user>-sandbox-<hash>`** (from `ampx sandbox`; a parent
stack with a nested stack per category). From the scaffold's default `auth` +
`data` resources:
- **Cognito User Pool** `ap-south-1_BMcejbOrq` + app client
  `60ke5obci3n27mtic4o1etgi84`. Email as username, email verification,
  password policy = min 8 chars with upper + lower + number + symbol. No users yet.
- **Cognito Identity Pool** `ap-south-1:6e9df3a3-f418-49f4-a812-760d2f57fecd`.
  Vends temporary AWS credentials; guest (unauthenticated) access is enabled.
- **IAM roles** — an authenticated and an unauthenticated role for the identity
  pool, plus service roles for the API.
- **AppSync GraphQL API** —
  `https://yyhvii5oy5dltexpjrcpcbhzgy.appsync-api.ap-south-1.amazonaws.com/graphql`.
  This is the default `data` resource.
- **DynamoDB table** backing the sample `Todo` model (name like `Todo-<apiId>-NONE`).
- **AppSync resolvers** — JS/VTL resolvers wired straight to DynamoDB. No Lambda
  in the default scaffold.
- **CloudWatch log group(s)** for AppSync.
- No S3 bucket in the app stack — file storage is a separate `defineStorage`
  resource we have not added.
- Cost at rest: within Free Tier (Cognito monthly-active-user free tier;
  on-demand DynamoDB with no traffic ≈ $0; AppSync billed per request).

### Note for later modules

The scaffold ships a **Todo example over AppSync/GraphQL**. Our plan is REST
(API Gateway + Lambda + DynamoDB) instead, so `data/resource.ts` gets replaced in
Module 03. The `auth` resource we keep, and configure properly in Module 02.

### Where to look
- CloudFormation console (ap-south-1): stacks `CDKToolkit` and
  `amplify-awsamp-...-sandbox-...`
- Cognito console: the user pool (empty)
- AppSync console: the GraphQL API
- Local: `.amplify/` holds sandbox metadata; `amplify_outputs.json` holds the
  frontend config (ids + endpoints above)

### Teardown
- `npx ampx sandbox delete` — deletes the sandbox stack and everything in it.
  Does **not** touch `CDKToolkit`.
- `CDKToolkit` can stay (costs ~nothing, reused by any future CDK/Amplify work in
  this region) or be deleted via console after emptying the
  `cdk-hnb659fds-assets-...` bucket.

## Open questions to resolve

- Amplify Hosting (needs GitHub repo) vs. local sandbox only for now?
- Frontend: Vite vanilla template vs. ESM CDN?
- Sample app domain: notes / todo / guestbook?

---

## Session log

### 2026-09-03
- Defined the goal and the 5-module path above.
- Module 00 done: AWS CLI configured (IAM user `amplifier`, ap-south-1);
  scaffolded with `npm create amplify@latest`; cleared a wedged `CDKToolkit`
  stack, re-bootstrapped, and `npx ampx sandbox` deployed successfully.
  `amplify_outputs.json` present. Full breakdown in "Module 00 — Setup: what
  actually happened" above.
- Decided: Lambda handlers in Go (see Preferences + Module 3). Module 3 will use
  a CDK `lambda.Function` on `provided.al2023`, not `defineFunction`.
- TODO (Module 03): update the "Amplify Gen 2 Ladder" artifact's Module 03
  snippets from `handler.js` / AWS SDK v3 to Go. Deferred until we reach it.
- Next: Module 01 — static site (Vite vanilla template → Amplify Hosting).
