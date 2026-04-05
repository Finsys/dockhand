/**
 * OpenAPI 3.0 Specification for Dockhand API
 *
 * This file defines the OpenAPI spec as a static TypeScript object.
 * It documents ALL REST API endpoints that Dockhand exposes across
 * 24 tag groups covering 130+ endpoints.
 */

export const openapiSpec = {
	openapi: '3.0.3',
	info: {
		title: 'Dockhand API',
		version: '1.0.17',
		description:
			'Dockhand is a Docker management platform that provides a REST API for managing containers, stacks, environments, and more. This documentation covers all API endpoints.',
		license: {
			name: 'AGPL-3.0',
			url: 'https://github.com/finsys/dockhand/blob/main/LICENSE'
		},
		contact: {
			name: 'Dockhand on GitHub',
			url: 'https://github.com/finsys/dockhand'
		}
	},
	servers: [
		{
			url: '/api',
			description: 'Dockhand API (relative to application root)'
		}
	],
	components: {
		securitySchemes: {
			cookieAuth: {
				type: 'apiKey' as const,
				in: 'cookie' as const,
				name: 'dockhand_session',
				description: 'Session cookie set after successful login via /api/auth/login'
			}
		},
		schemas: {
			Error: {
				type: 'object',
				properties: {
					error: {
						type: 'string',
						description: 'Error message'
					}
				}
			},
			Success: {
				type: 'object',
				properties: {
					success: {
						type: 'boolean',
						example: true
					}
				}
			},
			Health: {
				type: 'object',
				properties: {
					status: {
						type: 'string',
						example: 'ok'
					},
					timestamp: {
						type: 'string',
						format: 'date-time'
					}
				}
			},
			DatabaseHealth: {
				type: 'object',
				properties: {
					status: {
						type: 'string',
						example: 'ok'
					},
					database: {
						type: 'string',
						example: 'connected'
					},
					timestamp: {
						type: 'string',
						format: 'date-time'
					}
				}
			},
			Environment: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					host: { type: 'string', nullable: true },
					port: { type: 'integer', default: 2375 },
					protocol: { type: 'string', enum: ['http', 'https'], default: 'http' },
					connectionType: {
						type: 'string',
						enum: ['socket', 'direct', 'hawser-standard'],
						default: 'socket'
					},
					icon: { type: 'string', default: 'globe' },
					socketPath: { type: 'string', default: '/var/run/docker.sock' },
					collectActivity: { type: 'boolean', default: true },
					collectMetrics: { type: 'boolean', default: true },
					highlightChanges: { type: 'boolean', default: true },
					labels: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								text: { type: 'string' },
								color: { type: 'string' }
							}
						}
					},
					publicIp: { type: 'string', nullable: true },
					updateCheckEnabled: { type: 'boolean' },
					updateCheckAutoUpdate: { type: 'boolean' },
					imagePruneEnabled: { type: 'boolean' },
					timezone: { type: 'string', nullable: true }
				}
			},
			EnvironmentCreate: {
				type: 'object',
				required: ['name'],
				properties: {
					name: { type: 'string' },
					host: { type: 'string' },
					port: { type: 'integer', default: 2375 },
					protocol: { type: 'string', enum: ['http', 'https'], default: 'http' },
					connectionType: {
						type: 'string',
						enum: ['socket', 'direct', 'hawser-standard'],
						default: 'socket'
					},
					icon: { type: 'string', default: 'globe' },
					socketPath: { type: 'string', default: '/var/run/docker.sock' },
					collectActivity: { type: 'boolean', default: true },
					collectMetrics: { type: 'boolean', default: true },
					highlightChanges: { type: 'boolean', default: true },
					labels: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								text: { type: 'string' },
								color: { type: 'string' }
							}
						}
					},
					publicIp: { type: 'string' },
					tlsCa: { type: 'string' },
					tlsCert: { type: 'string' },
					tlsKey: { type: 'string' },
					tlsSkipVerify: { type: 'boolean', default: false },
					hawserToken: { type: 'string' }
				}
			},
			Container: {
				type: 'object',
				description: 'Docker container object (Docker Engine API format with Dockhand extensions)',
				properties: {
					Id: { type: 'string' },
					Names: { type: 'array', items: { type: 'string' } },
					Image: { type: 'string' },
					State: { type: 'string' },
					Status: { type: 'string' },
					Created: { type: 'integer', description: 'Unix timestamp' }
				}
			},
			ContainerInspect: {
				type: 'object',
				description: 'Full container inspect data from Docker Engine API'
			},
			ContainerStats: {
				type: 'object',
				description: 'Container resource usage statistics',
				properties: {
					cpu_percent: { type: 'number' },
					memory_usage: { type: 'integer' },
					memory_limit: { type: 'integer' },
					network_rx: { type: 'integer' },
					network_tx: { type: 'integer' }
				}
			},
			ContainerProcess: {
				type: 'object',
				description: 'Container top (process list) output',
				properties: {
					Titles: { type: 'array', items: { type: 'string' } },
					Processes: {
						type: 'array',
						items: { type: 'array', items: { type: 'string' } }
					}
				}
			},
			Stack: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					status: { type: 'string' },
					serviceCount: { type: 'integer' },
					runningCount: { type: 'integer' },
					sourceType: { type: 'string', nullable: true }
				}
			},
			StackCompose: {
				type: 'object',
				properties: {
					content: { type: 'string', description: 'Docker Compose YAML content' }
				}
			},
			StackEnv: {
				type: 'object',
				properties: {
					variables: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								key: { type: 'string' },
								value: { type: 'string' }
							}
						}
					}
				}
			},
			HawserToken: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					tokenPrefix: { type: 'string', description: 'First characters of the token for identification' },
					name: { type: 'string' },
					environmentId: { type: 'integer' },
					isActive: { type: 'boolean' },
					lastUsed: { type: 'string', format: 'date-time', nullable: true },
					createdAt: { type: 'string', format: 'date-time' },
					expiresAt: { type: 'string', format: 'date-time', nullable: true }
				}
			},
			HawserTokenCreate: {
				type: 'object',
				required: ['name', 'environmentId'],
				properties: {
					name: { type: 'string' },
					environmentId: { type: 'integer' },
					expiresAt: { type: 'string', format: 'date-time' }
				}
			},
			HawserTokenResponse: {
				type: 'object',
				properties: {
					token: {
						type: 'string',
						description: 'The full token value. Only shown once at creation time.'
					},
					tokenId: { type: 'integer' },
					message: { type: 'string' }
				}
			},
			Session: {
				type: 'object',
				properties: {
					authenticated: { type: 'boolean' },
					authEnabled: { type: 'boolean' },
					user: {
						type: 'object',
						nullable: true,
						properties: {
							id: { type: 'integer' },
							username: { type: 'string' },
							email: { type: 'string', nullable: true },
							displayName: { type: 'string', nullable: true },
							avatar: { type: 'string', nullable: true },
							isAdmin: { type: 'boolean' },
							provider: { type: 'string', nullable: true },
							permissions: {
								type: 'array',
								items: { type: 'string' }
							}
						}
					}
				}
			},
			LoginRequest: {
				type: 'object',
				required: ['username', 'password'],
				properties: {
					username: { type: 'string' },
					password: { type: 'string' },
					mfaToken: { type: 'string', description: 'MFA/TOTP token if MFA is enabled' },
					provider: {
						type: 'string',
						enum: ['local', 'ldap'],
						default: 'local'
					}
				}
			},
			AuthSettings: {
				type: 'object',
				properties: {
					authEnabled: { type: 'boolean' },
					registrationEnabled: { type: 'boolean' },
					defaultRole: { type: 'string' },
					mfaEnabled: { type: 'boolean' },
					ldapEnabled: { type: 'boolean' },
					oidcEnabled: { type: 'boolean' }
				}
			},
			AuthProvider: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					name: { type: 'string' },
					type: { type: 'string', enum: ['local', 'ldap', 'oidc'] },
					enabled: { type: 'boolean' }
				}
			},
			GitStack: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					repositoryUrl: { type: 'string' },
					branch: { type: 'string' },
					composePath: { type: 'string' },
					environmentId: { type: 'integer' },
					status: { type: 'string' },
					lastSync: { type: 'string', format: 'date-time', nullable: true },
					credentialId: { type: 'integer', nullable: true }
				}
			},
			GitCredential: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					type: { type: 'string', enum: ['ssh', 'token', 'basic'] },
					createdAt: { type: 'string', format: 'date-time' }
				}
			},
			Image: {
				type: 'object',
				properties: {
					Id: { type: 'string' },
					RepoTags: { type: 'array', items: { type: 'string' } },
					Size: { type: 'integer' },
					Created: { type: 'integer' }
				}
			},
			Network: {
				type: 'object',
				properties: {
					Id: { type: 'string' },
					Name: { type: 'string' },
					Driver: { type: 'string' },
					Scope: { type: 'string' }
				}
			},
			Volume: {
				type: 'object',
				properties: {
					Name: { type: 'string' },
					Driver: { type: 'string' },
					Mountpoint: { type: 'string' },
					CreatedAt: { type: 'string' }
				}
			},
			PruneResult: {
				type: 'object',
				properties: {
					deleted: { type: 'integer' },
					spaceReclaimed: { type: 'integer', description: 'Bytes reclaimed' }
				}
			},
			Registry: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					url: { type: 'string' },
					username: { type: 'string', nullable: true },
					createdAt: { type: 'string', format: 'date-time' }
				}
			},
			Notification: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					type: { type: 'string' },
					enabled: { type: 'boolean' },
					config: { type: 'object' }
				}
			},
			Schedule: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					type: { type: 'string' },
					enabled: { type: 'boolean' },
					cron: { type: 'string' },
					lastRun: { type: 'string', format: 'date-time', nullable: true },
					nextRun: { type: 'string', format: 'date-time', nullable: true }
				}
			},
			User: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					username: { type: 'string' },
					email: { type: 'string', nullable: true },
					displayName: { type: 'string', nullable: true },
					isAdmin: { type: 'boolean' },
					provider: { type: 'string' },
					createdAt: { type: 'string', format: 'date-time' }
				}
			},
			Role: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					description: { type: 'string', nullable: true },
					permissions: { type: 'array', items: { type: 'string' } }
				}
			},
			DashboardStats: {
				type: 'object',
				properties: {
					totalContainers: { type: 'integer' },
					runningContainers: { type: 'integer' },
					stoppedContainers: { type: 'integer' },
					totalStacks: { type: 'integer' },
					totalImages: { type: 'integer' },
					totalVolumes: { type: 'integer' },
					totalNetworks: { type: 'integer' }
				}
			},
			DashboardPreferences: {
				type: 'object',
				properties: {
					layout: { type: 'string' },
					widgets: { type: 'array', items: { type: 'object' } },
					refreshInterval: { type: 'integer' }
				}
			},
			ActivityEvent: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					type: { type: 'string' },
					action: { type: 'string' },
					resourceType: { type: 'string' },
					resourceName: { type: 'string' },
					timestamp: { type: 'string', format: 'date-time' },
					userId: { type: 'integer', nullable: true }
				}
			},
			AuditEvent: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					action: { type: 'string' },
					userId: { type: 'integer' },
					username: { type: 'string' },
					resource: { type: 'string' },
					details: { type: 'object' },
					timestamp: { type: 'string', format: 'date-time' },
					ipAddress: { type: 'string' }
				}
			},
			SystemInfo: {
				type: 'object',
				properties: {
					version: { type: 'string' },
					buildDate: { type: 'string' },
					nodeVersion: { type: 'string' },
					platform: { type: 'string' },
					uptime: { type: 'integer' }
				}
			},
			DiskUsage: {
				type: 'object',
				properties: {
					total: { type: 'integer' },
					used: { type: 'integer' },
					free: { type: 'integer' },
					dockerUsage: { type: 'object' }
				}
			},
			GeneralSettings: {
				type: 'object',
				properties: {
					appName: { type: 'string' },
					appUrl: { type: 'string' },
					telemetryEnabled: { type: 'boolean' }
				}
			},
			ScannerSettings: {
				type: 'object',
				properties: {
					enabled: { type: 'boolean' },
					provider: { type: 'string' },
					autoScan: { type: 'boolean' }
				}
			},
			ThemeSettings: {
				type: 'object',
				properties: {
					theme: { type: 'string', enum: ['light', 'dark', 'auto'] },
					customCss: { type: 'string', nullable: true }
				}
			},
			Profile: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					username: { type: 'string' },
					email: { type: 'string', nullable: true },
					displayName: { type: 'string', nullable: true },
					avatar: { type: 'string', nullable: true }
				}
			},
			ProfilePreferences: {
				type: 'object',
				properties: {
					theme: { type: 'string' },
					language: { type: 'string' },
					notificationsEnabled: { type: 'boolean' }
				}
			},
			ConfigSet: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					description: { type: 'string', nullable: true },
					config: { type: 'object' },
					createdAt: { type: 'string', format: 'date-time' },
					updatedAt: { type: 'string', format: 'date-time' }
				}
			},
			License: {
				type: 'object',
				properties: {
					valid: { type: 'boolean' },
					type: { type: 'string' },
					expiresAt: { type: 'string', format: 'date-time', nullable: true },
					features: { type: 'array', items: { type: 'string' } }
				}
			},
			AutoUpdateConfig: {
				type: 'object',
				properties: {
					enabled: { type: 'boolean' },
					schedule: { type: 'string' },
					autoRestart: { type: 'boolean' }
				}
			},
			TimezoneConfig: {
				type: 'object',
				properties: {
					timezone: { type: 'string', example: 'Europe/Berlin' }
				}
			},
			UpdateCheckConfig: {
				type: 'object',
				properties: {
					enabled: { type: 'boolean' },
					autoUpdate: { type: 'boolean' },
					schedule: { type: 'string', nullable: true }
				}
			},
			ImagePruneConfig: {
				type: 'object',
				properties: {
					enabled: { type: 'boolean' },
					schedule: { type: 'string', nullable: true },
					keepLatest: { type: 'integer' }
				}
			},
			EnvironmentNotification: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					notificationId: { type: 'integer' },
					environmentId: { type: 'integer' },
					events: { type: 'array', items: { type: 'string' } }
				}
			}
		},
		parameters: {
			envId: {
				name: 'env',
				in: 'query' as const,
				description: 'Environment ID to scope the request to',
				required: false,
				schema: { type: 'integer' }
			},
			pathId: {
				name: 'id',
				in: 'path' as const,
				required: true,
				schema: { type: 'integer' },
				description: 'Resource ID'
			},
			containerId: {
				name: 'id',
				in: 'path' as const,
				required: true,
				schema: { type: 'string' },
				description: 'Container ID or name'
			},
			stackName: {
				name: 'name',
				in: 'path' as const,
				required: true,
				schema: { type: 'string' },
				description: 'Stack name'
			},
			volumeName: {
				name: 'name',
				in: 'path' as const,
				required: true,
				schema: { type: 'string' },
				description: 'Volume name'
			}
		}
	},
	security: [{ cookieAuth: [] }],
	tags: [
		{ name: 'Health', description: 'Health check endpoints' },
		{ name: 'Auth', description: 'Authentication and session management' },
		{ name: 'Environments', description: 'Docker environment management' },
		{ name: 'Hawser', description: 'Hawser remote agent token management' },
		{ name: 'Containers', description: 'Container lifecycle and management' },
		{ name: 'Stacks', description: 'Docker Compose stack management' },
		{ name: 'Git', description: 'Git-based stack and credential management' },
		{ name: 'Images', description: 'Docker image management' },
		{ name: 'Networks', description: 'Docker network management' },
		{ name: 'Volumes', description: 'Docker volume management' },
		{ name: 'Auto-Update', description: 'Container auto-update configuration' },
		{ name: 'Prune', description: 'Docker resource cleanup' },
		{ name: 'Registries', description: 'Container registry management' },
		{ name: 'Dashboard', description: 'Dashboard statistics and preferences' },
		{ name: 'Activity', description: 'Activity tracking and event log' },
		{ name: 'Audit', description: 'Audit logging and compliance' },
		{ name: 'Notifications', description: 'Notification channel management' },
		{ name: 'Schedules', description: 'Scheduled task management' },
		{ name: 'Users', description: 'User management' },
		{ name: 'Roles', description: 'Role-based access control' },
		{ name: 'System', description: 'System information and settings' },
		{ name: 'Profile', description: 'Current user profile management' },
		{ name: 'Config Sets', description: 'Reusable configuration sets' },
		{ name: 'Logs', description: 'Log aggregation and viewing' }
	],
	paths: {
		// ============================================================
		// Health
		// ============================================================
		'/health': {
			get: {
				summary: 'Health check',
				description: 'Returns the health status of the Dockhand application.',
				tags: ['Health'],
				security: [],
				responses: {
					'200': {
						description: 'Application is healthy',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Health' }
							}
						}
					}
				}
			}
		},
		'/health/database': {
			get: {
				summary: 'Database health check',
				description: 'Returns the health status of the database connection.',
				tags: ['Health'],
				security: [],
				responses: {
					'200': {
						description: 'Database is healthy',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/DatabaseHealth' }
							}
						}
					},
					'503': {
						description: 'Database is unavailable',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
				}
			}
		},

		// ============================================================
		// Auth
		// ============================================================
		'/auth/login': {
			post: {
				summary: 'Authenticate user',
				description:
					'Authenticate with username and password. Supports local and LDAP providers. Sets a session cookie on success. Rate-limited by IP and username.',
				tags: ['Auth'],
				security: [],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/LoginRequest' }
						}
					}
				},
				responses: {
					'200': {
						description: 'Login successful or MFA required. Session cookie is set on success.',
						content: {
							'application/json': {
								schema: {
									oneOf: [
										{
											type: 'object',
											description: 'MFA required – re-submit with mfaToken',
											properties: {
												requiresMfa: {
													type: 'boolean',
													example: true,
													description: 'If true, a second request with mfaToken is needed'
												}
											},
											required: ['requiresMfa']
										},
										{
											type: 'object',
											description: 'Login successful',
											properties: {
												success: { type: 'boolean', example: true },
												user: {
													type: 'object',
													properties: {
														id: { type: 'integer' },
														username: { type: 'string' },
														email: { type: 'string', nullable: true },
														displayName: { type: 'string', nullable: true },
														isAdmin: { type: 'boolean' }
													}
												}
											},
											required: ['success', 'user']
										}
									]
								}
							}
						}
					},
					'400': {
						description: 'Missing credentials or auth not enabled',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'401': {
						description: 'Invalid credentials',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'429': {
						description: 'Too many login attempts',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
				}
			}
		},
		'/auth/logout': {
			post: {
				summary: 'Logout current user',
				description: 'Invalidate the current session and clear the session cookie.',
				tags: ['Auth'],
				responses: {
					'200': {
						description: 'Logout successful',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Success' } }
						}
					}
				}
			}
		},
		'/auth/session': {
			get: {
				summary: 'Get current session',
				description:
					'Returns the current authentication state including whether auth is enabled and the authenticated user details.',
				tags: ['Auth'],
				security: [],
				responses: {
					'200': {
						description: 'Current session information',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Session' }
							}
						}
					}
				}
			}
		},
		'/auth/settings': {
			get: {
				summary: 'Get auth settings',
				description: 'Returns authentication configuration settings.',
				tags: ['Auth'],
				responses: {
					'200': {
						description: 'Auth settings',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/AuthSettings' }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update auth settings',
				description: 'Update authentication configuration. Requires admin access.',
				tags: ['Auth'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/AuthSettings' }
						}
					}
				},
				responses: {
					'200': {
						description: 'Settings updated',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/AuthSettings' } }
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/auth/providers': {
			get: {
				summary: 'List auth providers',
				description: 'Returns available authentication providers (local, LDAP, OIDC).',
				tags: ['Auth'],
				security: [],
				responses: {
					'200': {
						description: 'List of auth providers',
						content: {
							'application/json': {
								schema: {
									type: 'array',
									items: { $ref: '#/components/schemas/AuthProvider' }
								}
							}
						}
					}
				}
			}
		},

		// ============================================================
		// Environments
		// ============================================================
		'/environments': {
			get: {
				summary: 'List all environments',
				description:
					'Returns all Docker environments the current user has access to. In enterprise mode, results are filtered by the user\'s role-based permissions.',
				tags: ['Environments'],
				responses: {
					'200': {
						description: 'List of environments',
						content: {
							'application/json': {
								schema: {
									type: 'array',
									items: { $ref: '#/components/schemas/Environment' }
								}
							}
						}
					},
					'403': {
						description: 'Permission denied',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
				}
			},
			post: {
				summary: 'Create a new environment',
				description:
					'Create a new Docker environment. Supports socket, direct TCP, and Hawser remote agent connections.',
				tags: ['Environments'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/EnvironmentCreate' }
						}
					}
				},
				responses: {
					'200': {
						description: 'Environment created',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Environment' }
							}
						}
					},
					'400': {
						description: 'Validation error (e.g. missing name or host)',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'403': {
						description: 'Permission denied',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'409': {
						description: 'Environment with this name already exists',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
				}
			}
		},
		'/environments/{id}': {
			get: {
				summary: 'Get environment by ID',
				description: 'Returns a single environment by its numeric ID.',
				tags: ['Environments'],
				parameters: [
					{
						name: 'id',
						in: 'path',
						required: true,
						schema: { type: 'integer' },
						description: 'Environment ID'
					}
				],
				responses: {
					'200': {
						description: 'Environment details',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Environment' }
							}
						}
					},
					'403': {
						description: 'Permission denied',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'404': {
						description: 'Environment not found',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
				}
			},
			put: {
				summary: 'Update environment',
				description: 'Update an existing environment\'s configuration.',
				tags: ['Environments'],
				parameters: [
					{
						name: 'id',
						in: 'path',
						required: true,
						schema: { type: 'integer' },
						description: 'Environment ID'
					}
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/EnvironmentCreate' }
						}
					}
				},
				responses: {
					'200': {
						description: 'Environment updated',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Environment' }
							}
						}
					},
					'403': {
						description: 'Permission denied',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'404': {
						description: 'Environment not found',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
				}
			},
			delete: {
				summary: 'Delete environment',
				description: 'Delete an environment and clean up associated resources (schedules, git stacks, Hawser connections).',
				tags: ['Environments'],
				parameters: [
					{
						name: 'id',
						in: 'path',
						required: true,
						schema: { type: 'integer' },
						description: 'Environment ID'
					}
				],
				responses: {
					'200': {
						description: 'Environment deleted',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Success' } }
						}
					},
					'403': {
						description: 'Permission denied',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'404': {
						description: 'Environment not found',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
				}
			}
		},
		'/environments/{id}/test': {
			post: {
				summary: 'Test environment connection',
				description: 'Test connectivity to the Docker daemon for this environment.',
				tags: ['Environments'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Environment ID' }
				],
				responses: {
					'200': { description: 'Connection successful', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Connection failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'Environment not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/environments/{id}/timezone': {
			get: {
				summary: 'Get environment timezone',
				description: 'Returns the timezone configuration for the environment.',
				tags: ['Environments'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Environment ID' }
				],
				responses: {
					'200': { description: 'Timezone config', content: { 'application/json': { schema: { $ref: '#/components/schemas/TimezoneConfig' } } } },
					'404': { description: 'Environment not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update environment timezone',
				description: 'Set the timezone for the environment.',
				tags: ['Environments'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Environment ID' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/TimezoneConfig' } } }
				},
				responses: {
					'200': { description: 'Timezone updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Environment not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/environments/{id}/update-check': {
			get: {
				summary: 'Get update check config',
				description: 'Returns the update check configuration for the environment.',
				tags: ['Environments'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Environment ID' }
				],
				responses: {
					'200': { description: 'Update check config', content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateCheckConfig' } } } },
					'404': { description: 'Environment not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update update-check config',
				description: 'Configure automatic update checking for the environment.',
				tags: ['Environments'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Environment ID' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateCheckConfig' } } }
				},
				responses: {
					'200': { description: 'Config updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Environment not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/environments/{id}/image-prune': {
			get: {
				summary: 'Get image prune config',
				description: 'Returns the image prune configuration for the environment.',
				tags: ['Environments'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Environment ID' }
				],
				responses: {
					'200': { description: 'Image prune config', content: { 'application/json': { schema: { $ref: '#/components/schemas/ImagePruneConfig' } } } },
					'404': { description: 'Environment not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update image prune config',
				description: 'Configure automatic image pruning for the environment.',
				tags: ['Environments'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Environment ID' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/ImagePruneConfig' } } }
				},
				responses: {
					'200': { description: 'Config updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Environment not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/environments/{id}/notifications': {
			get: {
				summary: 'List environment notifications',
				description: 'Returns notification configurations linked to this environment.',
				tags: ['Environments'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Environment ID' }
				],
				responses: {
					'200': {
						description: 'Environment notifications',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/EnvironmentNotification' } }
							}
						}
					},
					'404': { description: 'Environment not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			post: {
				summary: 'Add notification to environment',
				description: 'Link a notification channel to this environment.',
				tags: ['Environments'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Environment ID' }
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									notificationId: { type: 'integer' },
									events: { type: 'array', items: { type: 'string' } }
								},
								required: ['notificationId']
							}
						}
					}
				},
				responses: {
					'200': { description: 'Notification linked', content: { 'application/json': { schema: { $ref: '#/components/schemas/EnvironmentNotification' } } } },
					'400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'Environment not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/environments/{id}/notifications/{notificationId}': {
			delete: {
				summary: 'Remove notification from environment',
				description: 'Unlink a notification channel from this environment.',
				tags: ['Environments'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Environment ID' },
					{ name: 'notificationId', in: 'path', required: true, schema: { type: 'integer' }, description: 'Notification link ID' }
				],
				responses: {
					'200': { description: 'Notification unlinked', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/environments/detect-socket': {
			get: {
				summary: 'Detect Docker socket',
				description: 'Auto-detect available Docker socket paths on the host.',
				tags: ['Environments'],
				responses: {
					'200': {
						description: 'Detected socket paths',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										socketPath: { type: 'string' },
										available: { type: 'boolean' }
									}
								}
							}
						}
					}
				}
			}
		},

		// ============================================================
		// Hawser
		// ============================================================
		'/hawser/tokens': {
			get: {
				summary: 'List Hawser tokens',
				description:
					'List all Hawser remote agent tokens. Token values are not included — only the prefix is shown for identification. Requires admin access.',
				tags: ['Hawser'],
				responses: {
					'200': {
						description: 'List of Hawser tokens',
						content: {
							'application/json': {
								schema: {
									type: 'array',
									items: { $ref: '#/components/schemas/HawserToken' }
								}
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			post: {
				summary: 'Create a Hawser token',
				description:
					'Generate a new Hawser remote agent token. The full token is returned only once in the response — it cannot be retrieved again.',
				tags: ['Hawser'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/HawserTokenCreate' }
						}
					}
				},
				responses: {
					'200': {
						description: 'Token created. Save the token value — it will not be shown again.',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/HawserTokenResponse' }
							}
						}
					},
					'400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			delete: {
				summary: 'Revoke a Hawser token',
				description: 'Revoke (delete) a Hawser token by ID. Requires admin access.',
				tags: ['Hawser'],
				parameters: [
					{
						name: 'id',
						in: 'query',
						required: true,
						schema: { type: 'integer' },
						description: 'Token ID to revoke'
					}
				],
				responses: {
					'200': { description: 'Token revoked', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Token ID is required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Containers
		// ============================================================
		'/containers': {
			get: {
				summary: 'List containers',
				description:
					'List Docker containers for a specific environment. Returns an empty array if no environment is specified.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/envId' },
					{
						name: 'all',
						in: 'query',
						description: 'Include stopped containers (default: true)',
						required: false,
						schema: { type: 'boolean', default: true }
					}
				],
				responses: {
					'200': {
						description: 'List of containers',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Container' } }
							}
						}
					},
					'403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'Environment not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}': {
			get: {
				summary: 'Get container details',
				description: 'Returns details for a specific container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Container details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Container' } } } },
					'404': { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/inspect': {
			get: {
				summary: 'Inspect container',
				description: 'Returns the full Docker inspect output for a container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Container inspect data', content: { 'application/json': { schema: { $ref: '#/components/schemas/ContainerInspect' } } } },
					'404': { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/logs': {
			get: {
				summary: 'Get container logs',
				description: 'Returns log output from a container. Supports tail and since parameters.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' },
					{ name: 'tail', in: 'query', required: false, schema: { type: 'integer', default: 100 }, description: 'Number of lines from the end' },
					{ name: 'since', in: 'query', required: false, schema: { type: 'string' }, description: 'Timestamp or relative time' },
					{ name: 'timestamps', in: 'query', required: false, schema: { type: 'boolean', default: false }, description: 'Include timestamps' }
				],
				responses: {
					'200': { description: 'Container logs', content: { 'text/plain': { schema: { type: 'string' } } } },
					'404': { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/stats': {
			get: {
				summary: 'Get container stats',
				description: 'Returns resource usage statistics for a container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Container stats', content: { 'application/json': { schema: { $ref: '#/components/schemas/ContainerStats' } } } },
					'404': { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/top': {
			get: {
				summary: 'List container processes',
				description: 'Returns the list of running processes inside a container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Process list', content: { 'application/json': { schema: { $ref: '#/components/schemas/ContainerProcess' } } } },
					'404': { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/start': {
			post: {
				summary: 'Start a container',
				description: 'Start a stopped Docker container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Container started', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Failed to start container', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/stop': {
			post: {
				summary: 'Stop a container',
				description: 'Stop a running Docker container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Container stopped', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Failed to stop container', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/restart': {
			post: {
				summary: 'Restart a container',
				description: 'Restart a Docker container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Container restarted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Failed to restart container', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/pause': {
			post: {
				summary: 'Pause a container',
				description: 'Pause all processes within a container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Container paused', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Failed to pause container', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/unpause': {
			post: {
				summary: 'Unpause a container',
				description: 'Resume a paused container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Container unpaused', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Failed to unpause container', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/rename': {
			post: {
				summary: 'Rename a container',
				description: 'Rename a Docker container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name'],
								properties: { name: { type: 'string' } }
							}
						}
					}
				},
				responses: {
					'200': { description: 'Container renamed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Invalid name', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/update': {
			post: {
				summary: 'Update container resources',
				description: 'Update container resource limits (CPU, memory, restart policy).',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { type: 'object' } } }
				},
				responses: {
					'200': { description: 'Container updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Invalid parameters', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/exec': {
			post: {
				summary: 'Execute command in container',
				description: 'Execute a command inside a running container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['command'],
								properties: {
									command: { type: 'string' },
									workDir: { type: 'string' },
									user: { type: 'string' }
								}
							}
						}
					}
				},
				responses: {
					'200': {
						description: 'Command output',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										exitCode: { type: 'integer' },
										output: { type: 'string' }
									}
								}
							}
						}
					},
					'400': { description: 'Invalid command', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/shells': {
			get: {
				summary: 'List available shells',
				description: 'Returns available shell binaries inside the container (e.g. /bin/sh, /bin/bash).',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': {
						description: 'Available shells',
						content: {
							'application/json': {
								schema: { type: 'array', items: { type: 'string' } }
							}
						}
					},
					'404': { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/files': {
			get: {
				summary: 'Browse container files',
				description: 'List files and directories inside a container at the given path.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' },
					{ name: 'path', in: 'query', required: false, schema: { type: 'string', default: '/' }, description: 'Directory path' }
				],
				responses: {
					'200': { description: 'File listing', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
					'404': { description: 'Container or path not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/files/content': {
			get: {
				summary: 'Get file content from container',
				description: 'Read the content of a file inside a container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' },
					{ name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'File path' }
				],
				responses: {
					'200': { description: 'File content', content: { 'text/plain': { schema: { type: 'string' } } } },
					'404': { description: 'File not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/files/create': {
			post: {
				summary: 'Create file in container',
				description: 'Create a new file or directory inside a container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['path'],
								properties: {
									path: { type: 'string' },
									content: { type: 'string' },
									isDirectory: { type: 'boolean', default: false }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'File created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Invalid path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/files/upload': {
			post: {
				summary: 'Upload file to container',
				description: 'Upload a file to a container at the specified path.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: {
						'multipart/form-data': {
							schema: {
								type: 'object',
								properties: {
									file: { type: 'string', format: 'binary' },
									path: { type: 'string' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'File uploaded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Upload failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/files/delete': {
			post: {
				summary: 'Delete file in container',
				description: 'Delete a file or directory inside a container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['path'],
								properties: { path: { type: 'string' } }
							}
						}
					}
				},
				responses: {
					'200': { description: 'File deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'File not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/files/rename': {
			post: {
				summary: 'Rename file in container',
				description: 'Rename or move a file inside a container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['oldPath', 'newPath'],
								properties: {
									oldPath: { type: 'string' },
									newPath: { type: 'string' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'File renamed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'File not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/files/chmod': {
			post: {
				summary: 'Change file permissions in container',
				description: 'Change permissions of a file inside a container.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['path', 'mode'],
								properties: {
									path: { type: 'string' },
									mode: { type: 'string', example: '0644' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Permissions changed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'File not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/{id}/files/download': {
			get: {
				summary: 'Download file from container',
				description: 'Download a file from a container as a tar archive.',
				tags: ['Containers'],
				parameters: [
					{ $ref: '#/components/parameters/containerId' },
					{ $ref: '#/components/parameters/envId' },
					{ name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'File path to download' }
				],
				responses: {
					'200': { description: 'File download', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
					'404': { description: 'File not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/pending-updates': {
			get: {
				summary: 'List containers with pending updates',
				description: 'Returns containers that have newer image versions available.',
				tags: ['Containers'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Containers with pending updates', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Container' } } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/check-updates': {
			post: {
				summary: 'Check for container updates',
				description: 'Trigger an update check for all containers in an environment.',
				tags: ['Containers'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Update check initiated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/batch-update': {
			post: {
				summary: 'Batch update containers',
				description: 'Update multiple containers to their latest image versions.',
				tags: ['Containers'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									containerIds: { type: 'array', items: { type: 'string' } }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Batch update started', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/sizes': {
			get: {
				summary: 'Get container sizes',
				description: 'Returns disk usage information for containers.',
				tags: ['Containers'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Container sizes', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/containers/stats': {
			get: {
				summary: 'Get global container stats',
				description: 'Returns aggregated resource usage statistics for all containers in an environment.',
				tags: ['Containers'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Global container stats', content: { 'application/json': { schema: { type: 'object' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Stacks
		// ============================================================
		'/stacks': {
			get: {
				summary: 'List stacks',
				description:
					'List Docker Compose stacks for a specific environment. Includes both running stacks discovered from Docker and stacks tracked in the database.',
				tags: ['Stacks'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': {
						description: 'List of stacks',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Stack' } }
							}
						}
					},
					'403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/{name}': {
			get: {
				summary: 'Get stack details',
				description: 'Returns details for a specific stack including its services and status.',
				tags: ['Stacks'],
				parameters: [
					{ $ref: '#/components/parameters/stackName' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Stack details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Stack' } } } },
					'404': { description: 'Stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/{name}/compose': {
			get: {
				summary: 'Get stack compose file',
				description: 'Returns the docker-compose.yml content for a stack.',
				tags: ['Stacks'],
				parameters: [
					{ $ref: '#/components/parameters/stackName' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Compose file content', content: { 'application/json': { schema: { $ref: '#/components/schemas/StackCompose' } } } },
					'404': { description: 'Stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update stack compose file',
				description: 'Update the docker-compose.yml content for a stack.',
				tags: ['Stacks'],
				parameters: [
					{ $ref: '#/components/parameters/stackName' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/StackCompose' } } }
				},
				responses: {
					'200': { description: 'Compose file updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Invalid compose file', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'Stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/{name}/env': {
			get: {
				summary: 'Get stack environment variables',
				description: 'Returns parsed environment variables for a stack.',
				tags: ['Stacks'],
				parameters: [
					{ $ref: '#/components/parameters/stackName' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Environment variables', content: { 'application/json': { schema: { $ref: '#/components/schemas/StackEnv' } } } },
					'404': { description: 'Stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update stack environment variables',
				description: 'Update environment variables for a stack.',
				tags: ['Stacks'],
				parameters: [
					{ $ref: '#/components/parameters/stackName' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/StackEnv' } } }
				},
				responses: {
					'200': { description: 'Environment updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/{name}/env/raw': {
			get: {
				summary: 'Get raw .env file content',
				description: 'Returns the raw .env file content for a stack.',
				tags: ['Stacks'],
				parameters: [
					{ $ref: '#/components/parameters/stackName' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Raw .env content', content: { 'text/plain': { schema: { type: 'string' } } } },
					'404': { description: 'Stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/{name}/env/validate': {
			post: {
				summary: 'Validate stack environment',
				description: 'Validate environment variables against the compose file requirements.',
				tags: ['Stacks'],
				parameters: [
					{ $ref: '#/components/parameters/stackName' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': {
						description: 'Validation result',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										valid: { type: 'boolean' },
										missing: { type: 'array', items: { type: 'string' } },
										warnings: { type: 'array', items: { type: 'string' } }
									}
								}
							}
						}
					},
					'404': { description: 'Stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/{name}/start': {
			post: {
				summary: 'Start a stack',
				description: 'Start all services in a Docker Compose stack (docker compose up -d).',
				tags: ['Stacks'],
				parameters: [
					{ $ref: '#/components/parameters/stackName' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Stack started', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Failed to start stack', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/{name}/stop': {
			post: {
				summary: 'Stop a stack',
				description: 'Stop all services in a Docker Compose stack (docker compose stop).',
				tags: ['Stacks'],
				parameters: [
					{ $ref: '#/components/parameters/stackName' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Stack stopped', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Failed to stop stack', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/{name}/restart': {
			post: {
				summary: 'Restart a stack',
				description: 'Restart all services in a Docker Compose stack.',
				tags: ['Stacks'],
				parameters: [
					{ $ref: '#/components/parameters/stackName' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Stack restarted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Failed to restart stack', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/{name}/down': {
			post: {
				summary: 'Remove a stack',
				description: 'Stop and remove all services in a Docker Compose stack (docker compose down).',
				tags: ['Stacks'],
				parameters: [
					{ $ref: '#/components/parameters/stackName' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Stack removed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Failed to remove stack', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/{name}/relocate': {
			post: {
				summary: 'Relocate a stack',
				description: 'Move a stack to a different directory path.',
				tags: ['Stacks'],
				parameters: [
					{ $ref: '#/components/parameters/stackName' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['newPath'],
								properties: { newPath: { type: 'string' } }
							}
						}
					}
				},
				responses: {
					'200': { description: 'Stack relocated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Invalid path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'Stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/adopt': {
			post: {
				summary: 'Adopt an existing stack',
				description: 'Import an existing Docker Compose stack from disk into Dockhand management.',
				tags: ['Stacks'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['path'],
								properties: {
									path: { type: 'string' },
									name: { type: 'string' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Stack adopted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Stack' } } } },
					'400': { description: 'Invalid path or no compose file found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/scan': {
			post: {
				summary: 'Scan for stacks',
				description: 'Scan the filesystem for Docker Compose stacks that are not yet managed.',
				tags: ['Stacks'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': {
						description: 'Discovered stacks',
						content: {
							'application/json': {
								schema: { type: 'array', items: { type: 'object' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/sources': {
			get: {
				summary: 'List stack sources',
				description: 'Returns configured stack source directories.',
				tags: ['Stacks'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Stack sources', content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/base-path': {
			get: {
				summary: 'Get stack base path',
				description: 'Returns the base directory path where stacks are stored.',
				tags: ['Stacks'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': {
						description: 'Base path',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { path: { type: 'string' } } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/stacks/default-path': {
			get: {
				summary: 'Get default stack path',
				description: 'Returns the default directory path for new stacks.',
				tags: ['Stacks'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': {
						description: 'Default path',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { path: { type: 'string' } } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Git
		// ============================================================
		'/git/stacks': {
			get: {
				summary: 'List git-managed stacks',
				description: 'Returns all stacks managed via Git repositories.',
				tags: ['Git'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': {
						description: 'Git stacks',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/GitStack' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/git/stacks/{id}': {
			get: {
				summary: 'Get git stack details',
				description: 'Returns details for a specific git-managed stack.',
				tags: ['Git'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Git stack ID' }
				],
				responses: {
					'200': { description: 'Git stack details', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitStack' } } } },
					'404': { description: 'Git stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/git/stacks/{id}/deploy': {
			post: {
				summary: 'Deploy git stack',
				description: 'Deploy or redeploy a git-managed stack from its repository.',
				tags: ['Git'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Git stack ID' }
				],
				responses: {
					'200': { description: 'Deployment started', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Git stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Deployment failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/git/stacks/{id}/sync': {
			post: {
				summary: 'Sync git stack',
				description: 'Pull latest changes from the git repository without redeploying.',
				tags: ['Git'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Git stack ID' }
				],
				responses: {
					'200': { description: 'Sync completed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Git stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Sync failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/git/stacks/{id}/test': {
			post: {
				summary: 'Test git stack connection',
				description: 'Test connectivity to the git repository.',
				tags: ['Git'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Git stack ID' }
				],
				responses: {
					'200': { description: 'Connection successful', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Connection failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'Git stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/git/stacks/{id}/env-files': {
			get: {
				summary: 'List git stack env files',
				description: 'Returns .env files found in the git stack repository.',
				tags: ['Git'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Git stack ID' }
				],
				responses: {
					'200': {
						description: 'Env files',
						content: {
							'application/json': {
								schema: { type: 'array', items: { type: 'string' } }
							}
						}
					},
					'404': { description: 'Git stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/git/stacks/{id}/webhook': {
			post: {
				summary: 'Trigger git stack webhook',
				description: 'Webhook endpoint for triggering automatic deployments from Git providers.',
				tags: ['Git'],
				security: [],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Git stack ID' }
				],
				responses: {
					'200': { description: 'Webhook processed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Invalid webhook payload', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'Git stack not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/git/credentials': {
			get: {
				summary: 'List git credentials',
				description: 'Returns all stored git credentials.',
				tags: ['Git'],
				responses: {
					'200': {
						description: 'Git credentials',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/GitCredential' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			post: {
				summary: 'Create git credential',
				description: 'Store a new git credential (SSH key, token, or basic auth).',
				tags: ['Git'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name', 'type'],
								properties: {
									name: { type: 'string' },
									type: { type: 'string', enum: ['ssh', 'token', 'basic'] },
									username: { type: 'string' },
									password: { type: 'string' },
									token: { type: 'string' },
									sshKey: { type: 'string' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Credential created', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitCredential' } } } },
					'400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/git/credentials/{id}': {
			get: {
				summary: 'Get git credential',
				description: 'Returns a specific git credential by ID.',
				tags: ['Git'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Credential ID' }
				],
				responses: {
					'200': { description: 'Git credential', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitCredential' } } } },
					'404': { description: 'Credential not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update git credential',
				description: 'Update an existing git credential.',
				tags: ['Git'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Credential ID' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { type: 'object' } } }
				},
				responses: {
					'200': { description: 'Credential updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitCredential' } } } },
					'404': { description: 'Credential not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			delete: {
				summary: 'Delete git credential',
				description: 'Delete a git credential.',
				tags: ['Git'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Credential ID' }
				],
				responses: {
					'200': { description: 'Credential deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Credential not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Images
		// ============================================================
		'/images': {
			get: {
				summary: 'List images',
				description: 'List Docker images for a specific environment.',
				tags: ['Images'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': {
						description: 'List of images',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Image' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/images/{id}': {
			get: {
				summary: 'Get image details',
				description: 'Returns details for a specific Docker image.',
				tags: ['Images'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Image ID' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Image details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Image' } } } },
					'404': { description: 'Image not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			delete: {
				summary: 'Delete image',
				description: 'Remove a Docker image.',
				tags: ['Images'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Image ID' },
					{ $ref: '#/components/parameters/envId' },
					{ name: 'force', in: 'query', required: false, schema: { type: 'boolean', default: false }, description: 'Force removal' }
				],
				responses: {
					'200': { description: 'Image deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Image not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'409': { description: 'Image in use', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/images/{id}/history': {
			get: {
				summary: 'Get image history',
				description: 'Returns the build history of a Docker image.',
				tags: ['Images'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Image ID' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Image history', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
					'404': { description: 'Image not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/images/{id}/tag': {
			post: {
				summary: 'Tag an image',
				description: 'Add a tag to a Docker image.',
				tags: ['Images'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Image ID' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['repo', 'tag'],
								properties: {
									repo: { type: 'string' },
									tag: { type: 'string' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Image tagged', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Image not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/images/{id}/export': {
			post: {
				summary: 'Export an image',
				description: 'Export a Docker image as a tar archive.',
				tags: ['Images'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Image ID' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Image archive', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
					'404': { description: 'Image not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/images/pull': {
			post: {
				summary: 'Pull an image',
				description: 'Pull a Docker image from a registry.',
				tags: ['Images'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['image'],
								properties: {
									image: { type: 'string' },
									tag: { type: 'string', default: 'latest' },
									registryId: { type: 'integer' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Image pulled', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Invalid image reference', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Pull failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/images/push': {
			post: {
				summary: 'Push an image',
				description: 'Push a Docker image to a registry.',
				tags: ['Images'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['image'],
								properties: {
									image: { type: 'string' },
									tag: { type: 'string' },
									registryId: { type: 'integer' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Image pushed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Invalid image reference', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Push failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/images/scan': {
			post: {
				summary: 'Scan an image for vulnerabilities',
				description: 'Run a vulnerability scan on a Docker image using the configured scanner.',
				tags: ['Images'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['image'],
								properties: {
									image: { type: 'string' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Scan results', content: { 'application/json': { schema: { type: 'object' } } } },
					'400': { description: 'Invalid image', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Scan failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Networks
		// ============================================================
		'/networks': {
			get: {
				summary: 'List networks',
				description: 'List Docker networks for a specific environment.',
				tags: ['Networks'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': {
						description: 'List of networks',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Network' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/networks/{id}': {
			get: {
				summary: 'Get network details',
				description: 'Returns details for a specific Docker network.',
				tags: ['Networks'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Network ID' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Network details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Network' } } } },
					'404': { description: 'Network not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			delete: {
				summary: 'Delete network',
				description: 'Remove a Docker network.',
				tags: ['Networks'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Network ID' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Network deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Network not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'409': { description: 'Network in use', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/networks/{id}/inspect': {
			get: {
				summary: 'Inspect network',
				description: 'Returns the full Docker inspect output for a network.',
				tags: ['Networks'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Network ID' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Network inspect data', content: { 'application/json': { schema: { type: 'object' } } } },
					'404': { description: 'Network not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/networks/{id}/connect': {
			post: {
				summary: 'Connect container to network',
				description: 'Connect a container to a Docker network.',
				tags: ['Networks'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Network ID' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['containerId'],
								properties: { containerId: { type: 'string' } }
							}
						}
					}
				},
				responses: {
					'200': { description: 'Container connected', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Network or container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/networks/{id}/disconnect': {
			post: {
				summary: 'Disconnect container from network',
				description: 'Disconnect a container from a Docker network.',
				tags: ['Networks'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Network ID' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['containerId'],
								properties: { containerId: { type: 'string' } }
							}
						}
					}
				},
				responses: {
					'200': { description: 'Container disconnected', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Network or container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Volumes
		// ============================================================
		'/volumes': {
			get: {
				summary: 'List volumes',
				description: 'List Docker volumes for a specific environment.',
				tags: ['Volumes'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': {
						description: 'List of volumes',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Volume' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/volumes/{name}': {
			get: {
				summary: 'Get volume details',
				description: 'Returns details for a specific Docker volume.',
				tags: ['Volumes'],
				parameters: [
					{ $ref: '#/components/parameters/volumeName' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Volume details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Volume' } } } },
					'404': { description: 'Volume not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			delete: {
				summary: 'Delete volume',
				description: 'Remove a Docker volume.',
				tags: ['Volumes'],
				parameters: [
					{ $ref: '#/components/parameters/volumeName' },
					{ $ref: '#/components/parameters/envId' },
					{ name: 'force', in: 'query', required: false, schema: { type: 'boolean', default: false }, description: 'Force removal' }
				],
				responses: {
					'200': { description: 'Volume deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Volume not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'409': { description: 'Volume in use', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/volumes/{name}/inspect': {
			get: {
				summary: 'Inspect volume',
				description: 'Returns the full Docker inspect output for a volume.',
				tags: ['Volumes'],
				parameters: [
					{ $ref: '#/components/parameters/volumeName' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Volume inspect data', content: { 'application/json': { schema: { type: 'object' } } } },
					'404': { description: 'Volume not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/volumes/{name}/browse': {
			get: {
				summary: 'Browse volume files',
				description: 'List files and directories inside a volume.',
				tags: ['Volumes'],
				parameters: [
					{ $ref: '#/components/parameters/volumeName' },
					{ $ref: '#/components/parameters/envId' },
					{ name: 'path', in: 'query', required: false, schema: { type: 'string', default: '/' }, description: 'Directory path' }
				],
				responses: {
					'200': { description: 'File listing', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
					'404': { description: 'Volume not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/volumes/{name}/browse/content': {
			get: {
				summary: 'Get file content from volume',
				description: 'Read the content of a file inside a volume.',
				tags: ['Volumes'],
				parameters: [
					{ $ref: '#/components/parameters/volumeName' },
					{ $ref: '#/components/parameters/envId' },
					{ name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'File path' }
				],
				responses: {
					'200': { description: 'File content', content: { 'text/plain': { schema: { type: 'string' } } } },
					'404': { description: 'File not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/volumes/{name}/clone': {
			post: {
				summary: 'Clone volume',
				description: 'Create a copy of a Docker volume.',
				tags: ['Volumes'],
				parameters: [
					{ $ref: '#/components/parameters/volumeName' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['newName'],
								properties: { newName: { type: 'string' } }
							}
						}
					}
				},
				responses: {
					'200': { description: 'Volume cloned', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Volume not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'409': { description: 'Target volume already exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/volumes/{name}/export': {
			post: {
				summary: 'Export volume',
				description: 'Export a Docker volume as a tar archive.',
				tags: ['Volumes'],
				parameters: [
					{ $ref: '#/components/parameters/volumeName' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Volume archive', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
					'404': { description: 'Volume not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Auto-Update
		// ============================================================
		'/auto-update': {
			get: {
				summary: 'Get auto-update overview',
				description: 'Returns the auto-update configuration overview for all containers.',
				tags: ['Auto-Update'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Auto-update overview', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/AutoUpdateConfig' } } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/auto-update/{containerName}': {
			get: {
				summary: 'Get container auto-update config',
				description: 'Returns the auto-update configuration for a specific container.',
				tags: ['Auto-Update'],
				parameters: [
					{ name: 'containerName', in: 'path', required: true, schema: { type: 'string' }, description: 'Container name' },
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': { description: 'Auto-update config', content: { 'application/json': { schema: { $ref: '#/components/schemas/AutoUpdateConfig' } } } },
					'404': { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update container auto-update config',
				description: 'Configure auto-update settings for a specific container.',
				tags: ['Auto-Update'],
				parameters: [
					{ name: 'containerName', in: 'path', required: true, schema: { type: 'string' }, description: 'Container name' },
					{ $ref: '#/components/parameters/envId' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/AutoUpdateConfig' } } }
				},
				responses: {
					'200': { description: 'Config updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Prune
		// ============================================================
		'/prune/all': {
			post: {
				summary: 'Prune all resources',
				description: 'Remove all unused Docker resources (containers, images, networks, volumes).',
				tags: ['Prune'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Prune results', content: { 'application/json': { schema: { $ref: '#/components/schemas/PruneResult' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Prune failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/prune/containers': {
			post: {
				summary: 'Prune containers',
				description: 'Remove all stopped containers.',
				tags: ['Prune'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Prune results', content: { 'application/json': { schema: { $ref: '#/components/schemas/PruneResult' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/prune/images': {
			post: {
				summary: 'Prune images',
				description: 'Remove unused Docker images.',
				tags: ['Prune'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Prune results', content: { 'application/json': { schema: { $ref: '#/components/schemas/PruneResult' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/prune/networks': {
			post: {
				summary: 'Prune networks',
				description: 'Remove unused Docker networks.',
				tags: ['Prune'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Prune results', content: { 'application/json': { schema: { $ref: '#/components/schemas/PruneResult' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/prune/volumes': {
			post: {
				summary: 'Prune volumes',
				description: 'Remove unused Docker volumes.',
				tags: ['Prune'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Prune results', content: { 'application/json': { schema: { $ref: '#/components/schemas/PruneResult' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Registries
		// ============================================================
		'/registries': {
			get: {
				summary: 'List registries',
				description: 'Returns all configured container registries.',
				tags: ['Registries'],
				responses: {
					'200': {
						description: 'List of registries',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Registry' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			post: {
				summary: 'Create registry',
				description: 'Add a new container registry configuration.',
				tags: ['Registries'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name', 'url'],
								properties: {
									name: { type: 'string' },
									url: { type: 'string' },
									username: { type: 'string' },
									password: { type: 'string' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Registry created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Registry' } } } },
					'400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/registries/{id}': {
			get: {
				summary: 'Get registry details',
				description: 'Returns details for a specific registry.',
				tags: ['Registries'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Registry ID' }
				],
				responses: {
					'200': { description: 'Registry details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Registry' } } } },
					'404': { description: 'Registry not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update registry',
				description: 'Update an existing registry configuration.',
				tags: ['Registries'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Registry ID' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { type: 'object' } } }
				},
				responses: {
					'200': { description: 'Registry updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Registry' } } } },
					'404': { description: 'Registry not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			delete: {
				summary: 'Delete registry',
				description: 'Remove a registry configuration.',
				tags: ['Registries'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Registry ID' }
				],
				responses: {
					'200': { description: 'Registry deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Registry not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Dashboard
		// ============================================================
		'/dashboard/stats': {
			get: {
				summary: 'Get dashboard statistics',
				description: 'Returns aggregated statistics for the dashboard.',
				tags: ['Dashboard'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Dashboard stats', content: { 'application/json': { schema: { $ref: '#/components/schemas/DashboardStats' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/dashboard/preferences': {
			get: {
				summary: 'Get dashboard preferences',
				description: 'Returns the current user\'s dashboard layout preferences.',
				tags: ['Dashboard'],
				responses: {
					'200': { description: 'Dashboard preferences', content: { 'application/json': { schema: { $ref: '#/components/schemas/DashboardPreferences' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update dashboard preferences',
				description: 'Update the current user\'s dashboard layout preferences.',
				tags: ['Dashboard'],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/DashboardPreferences' } } }
				},
				responses: {
					'200': { description: 'Preferences updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Activity
		// ============================================================
		'/activity': {
			get: {
				summary: 'Get activity feed',
				description: 'Returns the activity feed with recent events.',
				tags: ['Activity'],
				parameters: [
					{ $ref: '#/components/parameters/envId' },
					{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50 }, description: 'Max results' },
					{ name: 'offset', in: 'query', required: false, schema: { type: 'integer', default: 0 }, description: 'Offset for pagination' }
				],
				responses: {
					'200': {
						description: 'Activity events',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/ActivityEvent' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/activity/containers': {
			get: {
				summary: 'Get container activity',
				description: 'Returns activity events filtered to container-related actions.',
				tags: ['Activity'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Container activity', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ActivityEvent' } } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/activity/events': {
			get: {
				summary: 'Get Docker events',
				description: 'Returns Docker daemon events for the environment.',
				tags: ['Activity'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Docker events', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/activity/stats': {
			get: {
				summary: 'Get activity statistics',
				description: 'Returns aggregated activity statistics.',
				tags: ['Activity'],
				parameters: [{ $ref: '#/components/parameters/envId' }],
				responses: {
					'200': { description: 'Activity stats', content: { 'application/json': { schema: { type: 'object' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Audit
		// ============================================================
		'/audit': {
			get: {
				summary: 'Get audit log',
				description: 'Returns the audit log with user actions.',
				tags: ['Audit'],
				parameters: [
					{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50 }, description: 'Max results' },
					{ name: 'offset', in: 'query', required: false, schema: { type: 'integer', default: 0 }, description: 'Offset for pagination' }
				],
				responses: {
					'200': {
						description: 'Audit events',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/AuditEvent' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/audit/events': {
			get: {
				summary: 'Get audit events',
				description: 'Returns detailed audit events with filtering options.',
				tags: ['Audit'],
				parameters: [
					{ name: 'action', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by action type' },
					{ name: 'userId', in: 'query', required: false, schema: { type: 'integer' }, description: 'Filter by user ID' }
				],
				responses: {
					'200': { description: 'Audit events', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/AuditEvent' } } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/audit/users': {
			get: {
				summary: 'Get audit users',
				description: 'Returns a list of users that appear in the audit log.',
				tags: ['Audit'],
				responses: {
					'200': { description: 'Audit users', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/audit/export': {
			get: {
				summary: 'Export audit log',
				description: 'Export the audit log as a downloadable file.',
				tags: ['Audit'],
				parameters: [
					{ name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['csv', 'json'], default: 'json' }, description: 'Export format' }
				],
				responses: {
					'200': { description: 'Audit export', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Notifications
		// ============================================================
		'/notifications': {
			get: {
				summary: 'List notifications',
				description: 'Returns all configured notification channels.',
				tags: ['Notifications'],
				responses: {
					'200': {
						description: 'List of notifications',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Notification' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			post: {
				summary: 'Create notification',
				description: 'Create a new notification channel (e.g. webhook, email, Slack).',
				tags: ['Notifications'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name', 'type'],
								properties: {
									name: { type: 'string' },
									type: { type: 'string' },
									enabled: { type: 'boolean', default: true },
									config: { type: 'object' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Notification created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Notification' } } } },
					'400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/notifications/{id}': {
			get: {
				summary: 'Get notification details',
				description: 'Returns details for a specific notification channel.',
				tags: ['Notifications'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Notification ID' }
				],
				responses: {
					'200': { description: 'Notification details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Notification' } } } },
					'404': { description: 'Notification not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update notification',
				description: 'Update an existing notification channel.',
				tags: ['Notifications'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Notification ID' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { type: 'object' } } }
				},
				responses: {
					'200': { description: 'Notification updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Notification' } } } },
					'404': { description: 'Notification not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			delete: {
				summary: 'Delete notification',
				description: 'Remove a notification channel.',
				tags: ['Notifications'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Notification ID' }
				],
				responses: {
					'200': { description: 'Notification deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Notification not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/notifications/{id}/test': {
			post: {
				summary: 'Test notification',
				description: 'Send a test message through the notification channel.',
				tags: ['Notifications'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Notification ID' }
				],
				responses: {
					'200': { description: 'Test sent', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Notification not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'500': { description: 'Test failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Schedules
		// ============================================================
		'/schedules': {
			get: {
				summary: 'List schedules',
				description: 'Returns all configured scheduled tasks.',
				tags: ['Schedules'],
				responses: {
					'200': {
						description: 'List of schedules',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Schedule' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/schedules/settings': {
			get: {
				summary: 'Get schedule settings',
				description: 'Returns global schedule configuration settings.',
				tags: ['Schedules'],
				responses: {
					'200': { description: 'Schedule settings', content: { 'application/json': { schema: { type: 'object' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update schedule settings',
				description: 'Update global schedule configuration.',
				tags: ['Schedules'],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { type: 'object' } } }
				},
				responses: {
					'200': { description: 'Settings updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/schedules/executions': {
			get: {
				summary: 'List schedule executions',
				description: 'Returns recent schedule execution history.',
				tags: ['Schedules'],
				responses: {
					'200': { description: 'Execution history', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/schedules/{type}/{id}': {
			get: {
				summary: 'Get schedule details',
				description: 'Returns details for a specific schedule by type and ID.',
				tags: ['Schedules'],
				parameters: [
					{ name: 'type', in: 'path', required: true, schema: { type: 'string' }, description: 'Schedule type' },
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Schedule ID' }
				],
				responses: {
					'200': { description: 'Schedule details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Schedule' } } } },
					'404': { description: 'Schedule not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/schedules/{type}/{id}/run': {
			post: {
				summary: 'Run schedule now',
				description: 'Manually trigger a scheduled task to run immediately.',
				tags: ['Schedules'],
				parameters: [
					{ name: 'type', in: 'path', required: true, schema: { type: 'string' }, description: 'Schedule type' },
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Schedule ID' }
				],
				responses: {
					'200': { description: 'Schedule triggered', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Schedule not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/schedules/{type}/{id}/toggle': {
			post: {
				summary: 'Toggle schedule',
				description: 'Enable or disable a scheduled task.',
				tags: ['Schedules'],
				parameters: [
					{ name: 'type', in: 'path', required: true, schema: { type: 'string' }, description: 'Schedule type' },
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Schedule ID' }
				],
				responses: {
					'200': { description: 'Schedule toggled', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Schedule not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Users
		// ============================================================
		'/users': {
			get: {
				summary: 'List users',
				description: 'Returns all users. Requires admin access.',
				tags: ['Users'],
				responses: {
					'200': {
						description: 'List of users',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/User' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			post: {
				summary: 'Create user',
				description: 'Create a new user account. Requires admin access.',
				tags: ['Users'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['username', 'password'],
								properties: {
									username: { type: 'string' },
									password: { type: 'string' },
									email: { type: 'string' },
									displayName: { type: 'string' },
									isAdmin: { type: 'boolean', default: false },
									roleId: { type: 'integer' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'User created', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
					'400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'409': { description: 'Username already exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/users/{id}': {
			get: {
				summary: 'Get user details',
				description: 'Returns details for a specific user.',
				tags: ['Users'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'User ID' }
				],
				responses: {
					'200': { description: 'User details', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'User not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update user',
				description: 'Update an existing user account.',
				tags: ['Users'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'User ID' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { type: 'object' } } }
				},
				responses: {
					'200': { description: 'User updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'User not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			delete: {
				summary: 'Delete user',
				description: 'Delete a user account. Requires admin access.',
				tags: ['Users'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'User ID' }
				],
				responses: {
					'200': { description: 'User deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'User not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Roles
		// ============================================================
		'/roles': {
			get: {
				summary: 'List roles',
				description: 'Returns all defined roles for RBAC.',
				tags: ['Roles'],
				responses: {
					'200': {
						description: 'List of roles',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Role' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			post: {
				summary: 'Create role',
				description: 'Create a new role with specified permissions.',
				tags: ['Roles'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name'],
								properties: {
									name: { type: 'string' },
									description: { type: 'string' },
									permissions: { type: 'array', items: { type: 'string' } }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Role created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Role' } } } },
					'400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/roles/{id}': {
			get: {
				summary: 'Get role details',
				description: 'Returns details for a specific role.',
				tags: ['Roles'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Role ID' }
				],
				responses: {
					'200': { description: 'Role details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Role' } } } },
					'404': { description: 'Role not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update role',
				description: 'Update an existing role.',
				tags: ['Roles'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Role ID' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { type: 'object' } } }
				},
				responses: {
					'200': { description: 'Role updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Role' } } } },
					'404': { description: 'Role not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			delete: {
				summary: 'Delete role',
				description: 'Delete a role.',
				tags: ['Roles'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Role ID' }
				],
				responses: {
					'200': { description: 'Role deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Role not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// System
		// ============================================================
		'/system': {
			get: {
				summary: 'Get system information',
				description: 'Returns system information including version, platform, and uptime.',
				tags: ['System'],
				responses: {
					'200': { description: 'System info', content: { 'application/json': { schema: { $ref: '#/components/schemas/SystemInfo' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/system/disk': {
			get: {
				summary: 'Get disk usage',
				description: 'Returns disk usage information for the system and Docker.',
				tags: ['System'],
				responses: {
					'200': { description: 'Disk usage', content: { 'application/json': { schema: { $ref: '#/components/schemas/DiskUsage' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/metrics': {
			get: {
				summary: 'Get Prometheus metrics',
				description: 'Returns metrics in Prometheus exposition format.',
				tags: ['System'],
				security: [],
				responses: {
					'200': { description: 'Prometheus metrics', content: { 'text/plain': { schema: { type: 'string' } } } }
				}
			}
		},
		'/changelog': {
			get: {
				summary: 'Get changelog',
				description: 'Returns the application changelog.',
				tags: ['System'],
				responses: {
					'200': { description: 'Changelog', content: { 'application/json': { schema: { type: 'object' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/settings/general': {
			get: {
				summary: 'Get general settings',
				description: 'Returns general application settings.',
				tags: ['System'],
				responses: {
					'200': { description: 'General settings', content: { 'application/json': { schema: { $ref: '#/components/schemas/GeneralSettings' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update general settings',
				description: 'Update general application settings. Requires admin access.',
				tags: ['System'],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/GeneralSettings' } } }
				},
				responses: {
					'200': { description: 'Settings updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/settings/scanner': {
			get: {
				summary: 'Get scanner settings',
				description: 'Returns vulnerability scanner configuration.',
				tags: ['System'],
				responses: {
					'200': { description: 'Scanner settings', content: { 'application/json': { schema: { $ref: '#/components/schemas/ScannerSettings' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update scanner settings',
				description: 'Update vulnerability scanner configuration.',
				tags: ['System'],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/ScannerSettings' } } }
				},
				responses: {
					'200': { description: 'Settings updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/settings/theme': {
			get: {
				summary: 'Get theme settings',
				description: 'Returns theme configuration.',
				tags: ['System'],
				responses: {
					'200': { description: 'Theme settings', content: { 'application/json': { schema: { $ref: '#/components/schemas/ThemeSettings' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update theme settings',
				description: 'Update theme configuration.',
				tags: ['System'],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/ThemeSettings' } } }
				},
				responses: {
					'200': { description: 'Settings updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/host': {
			get: {
				summary: 'Get host information',
				description: 'Returns information about the host system.',
				tags: ['System'],
				responses: {
					'200': { description: 'Host info', content: { 'application/json': { schema: { type: 'object' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/license': {
			get: {
				summary: 'Get license information',
				description: 'Returns current license status and features.',
				tags: ['System'],
				responses: {
					'200': { description: 'License info', content: { 'application/json': { schema: { $ref: '#/components/schemas/License' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			post: {
				summary: 'Activate license',
				description: 'Activate or update the license key.',
				tags: ['System'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['key'],
								properties: { key: { type: 'string' } }
							}
						}
					}
				},
				responses: {
					'200': { description: 'License activated', content: { 'application/json': { schema: { $ref: '#/components/schemas/License' } } } },
					'400': { description: 'Invalid license key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Profile
		// ============================================================
		'/profile': {
			get: {
				summary: 'Get current user profile',
				description: 'Returns the profile of the currently authenticated user.',
				tags: ['Profile'],
				responses: {
					'200': { description: 'User profile', content: { 'application/json': { schema: { $ref: '#/components/schemas/Profile' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update current user profile',
				description: 'Update the profile of the currently authenticated user.',
				tags: ['Profile'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									email: { type: 'string' },
									displayName: { type: 'string' },
									currentPassword: { type: 'string' },
									newPassword: { type: 'string' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Profile updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Profile' } } } },
					'400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/profile/avatar': {
			get: {
				summary: 'Get user avatar',
				description: 'Returns the avatar image for the current user.',
				tags: ['Profile'],
				responses: {
					'200': { description: 'Avatar image', content: { 'image/*': { schema: { type: 'string', format: 'binary' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'404': { description: 'No avatar set', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			post: {
				summary: 'Upload user avatar',
				description: 'Upload a new avatar image for the current user.',
				tags: ['Profile'],
				requestBody: {
					required: true,
					content: {
						'multipart/form-data': {
							schema: {
								type: 'object',
								properties: {
									avatar: { type: 'string', format: 'binary' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Avatar uploaded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'400': { description: 'Invalid image', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/profile/preferences': {
			get: {
				summary: 'Get user preferences',
				description: 'Returns preferences for the current user.',
				tags: ['Profile'],
				responses: {
					'200': { description: 'User preferences', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProfilePreferences' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update user preferences',
				description: 'Update preferences for the current user.',
				tags: ['Profile'],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/ProfilePreferences' } } }
				},
				responses: {
					'200': { description: 'Preferences updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Config Sets
		// ============================================================
		'/config-sets': {
			get: {
				summary: 'List config sets',
				description: 'Returns all reusable configuration sets.',
				tags: ['Config Sets'],
				responses: {
					'200': {
						description: 'List of config sets',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/ConfigSet' } }
							}
						}
					},
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			post: {
				summary: 'Create config set',
				description: 'Create a new reusable configuration set.',
				tags: ['Config Sets'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name'],
								properties: {
									name: { type: 'string' },
									description: { type: 'string' },
									config: { type: 'object' }
								}
							}
						}
					}
				},
				responses: {
					'200': { description: 'Config set created', content: { 'application/json': { schema: { $ref: '#/components/schemas/ConfigSet' } } } },
					'400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},
		'/config-sets/{id}': {
			get: {
				summary: 'Get config set details',
				description: 'Returns details for a specific configuration set.',
				tags: ['Config Sets'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Config set ID' }
				],
				responses: {
					'200': { description: 'Config set details', content: { 'application/json': { schema: { $ref: '#/components/schemas/ConfigSet' } } } },
					'404': { description: 'Config set not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			put: {
				summary: 'Update config set',
				description: 'Update an existing configuration set.',
				tags: ['Config Sets'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Config set ID' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { type: 'object' } } }
				},
				responses: {
					'200': { description: 'Config set updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/ConfigSet' } } } },
					'404': { description: 'Config set not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			},
			delete: {
				summary: 'Delete config set',
				description: 'Delete a configuration set.',
				tags: ['Config Sets'],
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Config set ID' }
				],
				responses: {
					'200': { description: 'Config set deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
					'404': { description: 'Config set not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		},

		// ============================================================
		// Logs
		// ============================================================
		'/logs/merged': {
			get: {
				summary: 'Get merged logs',
				description: 'Returns merged log output from multiple containers or services.',
				tags: ['Logs'],
				parameters: [
					{ $ref: '#/components/parameters/envId' },
					{ name: 'containers', in: 'query', required: false, schema: { type: 'string' }, description: 'Comma-separated container names' },
					{ name: 'tail', in: 'query', required: false, schema: { type: 'integer', default: 100 }, description: 'Number of lines' },
					{ name: 'since', in: 'query', required: false, schema: { type: 'string' }, description: 'Timestamp or relative time' }
				],
				responses: {
					'200': { description: 'Merged logs', content: { 'text/plain': { schema: { type: 'string' } } } },
					'401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
				}
			}
		}
	}
} as const;
