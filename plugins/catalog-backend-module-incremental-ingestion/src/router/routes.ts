/*
 * Copyright 2022 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { errorHandler } from '@backstage/backend-common';
import { stringifyError } from '@backstage/errors';
import { EventBroker, EventPublisher } from '@backstage/plugin-events-node';
import express from 'express';
import Router from 'express-promise-router';
import { Logger } from 'winston';
import { IncrementalIngestionDatabaseManager } from '../database/IncrementalIngestionDatabaseManager';
import { PROVIDER_BASE_PATH, PROVIDER_CLEANUP, PROVIDER_HEALTH } from './paths';

export class IncrementalProviderRouter implements EventPublisher {
  private manager: IncrementalIngestionDatabaseManager;
  private logger: Logger;
  private eventBroker: EventBroker | undefined;

  constructor(manager: IncrementalIngestionDatabaseManager, logger: Logger) {
    this.manager = manager;
    this.logger = logger;
  }

  async setEventBroker(eventBroker: EventBroker): Promise<void> {
    this.eventBroker = eventBroker;
  }

  async createRouter() {
    const router = Router();
    router.use(express.json());

    // Get the overall health of all incremental providers
    router.get(PROVIDER_HEALTH, async (_, res) => {
      const records = await this.manager.healthcheck();
      const providers = records.map(record => record.provider_name);
      const duplicates = [
        ...new Set(providers.filter((e, i, a) => a.indexOf(e) !== i)),
      ];

      if (duplicates.length > 0) {
        res.json({ healthy: false, duplicateIngestions: duplicates });
      } else {
        res.json({ healthy: true });
      }
    });

    // Clean up and pause all providers
    router.post(PROVIDER_CLEANUP, async (_, res) => {
      const result = await this.manager.cleanupProviders();
      res.json(result);
    });

    // Get basic status of the provider
    router.get(PROVIDER_BASE_PATH, async (req, res) => {
      const { provider } = req.params;
      const record = await this.manager.getCurrentIngestionRecord(provider);
      if (record) {
        res.json({
          success: true,
          status: {
            current_action: record.status,
            next_action_at: new Date(record.next_action_at),
          },
          last_error: record.last_error,
        });
      } else {
        const providers: string[] = await this.manager.listProviders();
        if (providers.includes(provider)) {
          res.json({
            success: true,
            status: {
              current_action: 'rest complete, waiting to start',
            },
          });
        } else {
          this.logger.error(
            `${provider} - No ingestion record found in the database!`,
          );
          res.status(404).json({
            success: false,
            status: {},
            last_error: `Provider '${provider}' not found`,
          });
        }
      }
    });

    // Trigger the provider's next action
    router.post(`${PROVIDER_BASE_PATH}/trigger`, async (req, res) => {
      const { provider } = req.params;
      const record = await this.manager.getCurrentIngestionRecord(provider);
      if (record) {
        await this.manager.triggerNextProviderAction(provider);
        res.json({
          success: true,
          message: `${provider}: Next action triggered.`,
        });
      } else {
        const providers: string[] = await this.manager.listProviders();
        if (providers.includes(provider)) {
          this.logger.debug(`${provider} - Ingestion record found`);
          res.json({
            success: true,
            message: 'Unable to trigger next action (provider is restarting)',
          });
        } else {
          res.status(404).json({
            success: false,
            message: `Provider '${provider}' not found`,
          });
        }
      }
    });

    // Start a brand-new ingestion cycle for the provider.
    // (Cancel's the current run if active, or marks it complete if resting)
    router.post(`${PROVIDER_BASE_PATH}/start`, async (req, res) => {
      const { provider } = req.params;

      const record = await this.manager.getCurrentIngestionRecord(provider);
      if (record) {
        const ingestionId = record.id;
        if (record.status === 'resting') {
          await this.manager.setProviderComplete(ingestionId);
        } else {
          await this.manager.setProviderCanceling(ingestionId);
        }
        res.json({
          success: true,
          message: `${provider}: Next cycle triggered.`,
        });
      } else {
        const providers: string[] = await this.manager.listProviders();
        if (providers.includes(provider)) {
          this.logger.debug(`${provider} - Ingestion record found`);
          res.json({
            success: true,
            message: 'Provider is already restarting',
          });
        } else {
          res.status(404).json({
            success: false,
            message: `Provider '${provider}' not found`,
          });
        }
      }
    });

    // Stop the provider and pause it for 24 hours
    router.post(`${PROVIDER_BASE_PATH}/cancel`, async (req, res) => {
      const { provider } = req.params;
      const record = await this.manager.getCurrentIngestionRecord(provider);
      if (record) {
        const next_action_at = new Date();
        next_action_at.setTime(next_action_at.getTime() + 24 * 60 * 60 * 1000);
        await this.manager.updateByName(provider, {
          next_action: 'nothing (done)',
          ingestion_completed_at: new Date(),
          next_action_at,
          status: 'resting',
        });
        res.json({
          success: true,
          message: `${provider}: Current ingestion canceled.`,
        });
      } else {
        const providers: string[] = await this.manager.listProviders();
        if (providers.includes(provider)) {
          this.logger.debug(`${provider} - Ingestion record found`);
          res.json({
            success: true,
            message: 'Provider is currently restarting, please wait.',
          });
        } else {
          res.status(404).json({
            success: false,
            message: `Provider '${provider}' not found`,
          });
        }
      }
    });

    // Wipe out all ingestion records for the provider and pause for 24 hours
    router.delete(PROVIDER_BASE_PATH, async (req, res) => {
      const { provider } = req.params;
      const result = await this.manager.purgeAndResetProvider(provider);
      res.json(result);
    });

    // Get the ingestion marks for the current cycle
    router.get(`${PROVIDER_BASE_PATH}/marks`, async (req, res) => {
      const { provider } = req.params;
      const record = await this.manager.getCurrentIngestionRecord(provider);
      if (record) {
        const id = record.id;
        const records = await this.manager.getAllMarks(id);
        res.json({ success: true, records });
      } else {
        const providers: string[] = await this.manager.listProviders();
        if (providers.includes(provider)) {
          this.logger.debug(`${provider} - Ingestion record found`);
          res.json({
            success: true,
            message: 'No records yet (provider is restarting)',
          });
        } else {
          this.logger.error(
            `${provider} - No ingestion record found in the database!`,
          );
          res.status(404).json({
            success: false,
            status: {},
            last_error: `Provider '${provider}' not found`,
          });
        }
      }
    });

    router.delete(`${PROVIDER_BASE_PATH}/marks`, async (req, res) => {
      const { provider } = req.params;
      const deletions = await this.manager.clearFinishedIngestions(provider);

      res.json({
        success: true,
        message: `Expired marks for provider '${provider}' removed.`,
        deletions,
      });
    });

    router.post(`${PROVIDER_BASE_PATH}/delta`, async (req, res) => {
      const { provider } = req.params;

      const topic = `${provider}-push`;

      const eventPayload = req.body;

      if (!this.eventBroker) {
        res.status(500).json({
          success: false,
          provider,
          message: `The payload could not be processed!`,
        });
        throw new Error('Event broker not initialized!');
      }

      try {
        await this.eventBroker.publish({
          topic,
          eventPayload,
        });
        res.json({
          success: true,
          provider,
          message: 'Payload submitted.',
        });
      } catch (e) {
        res.status(500).json({
          success: false,
          provider,
          message: `There was an error submitting the payload: ${stringifyError(
            e,
          )}`,
        });
      }
    });

    router.use(errorHandler());

    return router;
  }
}
