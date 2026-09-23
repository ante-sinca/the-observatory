# HomeBound — Project #1 Configuration

This document describes how HomeBound should be configured in Observatory. It is not a HomeBound-specific core implementation.

## Project

slug: homebound
name: HomeBound

## Repository source

Provider: GitHub or local filesystem during development.
Default branch: main.

## Include policy

Documentation-first:
- README.md
- AGENTS.md when present
- docs/**
- package.json
- relevant configuration manifests

Implementation evidence:
- lib/**
- app/**
- tests/**

## Exclude policy

- .env*
- secrets
- credentials
- node_modules/**
- .next/**
- build/**
- coverage/**
- binary artifacts unless explicitly supported

## Domains

- treasury
- reconciliation
- pricing
- payout
- transaction
- integrations
- deployment
- security

## Initial extraction rules

v0.1 should not attempt unrestricted LLM inference. Start with deterministic signals:

1. Markdown headings and frontmatter become document/decision candidates.
2. ADR-like filenames become decision items.
3. Test names become test_evidence candidates.
4. Deployment revision maps deployed_state to matching repository revision where possible.
5. Selected operator-entered assertions may become invariant or planned_change items with explicit provenance type `operator`.

## Initial HomeBound seed assertions

The operator may enter current known assertions manually in Observatory after registration. They must be marked as operator assertions until verified by repository evidence.

Suggested initial assertions:
- new deposit reconciliation applies prospectively
- historical/cancelled records should not be replayed into the new reconciliation flow
- transaction-fee accounting is distinct from payout principal accounting
- customer-facing pricing may differ from internal FX/risk calculations

Do not treat these as automatically verified simply because they are seeded.
