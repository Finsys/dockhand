/**
 * OpenAPI 3.0 Specification for Dockhand API
 *
 * This file defines the OpenAPI spec as a static TypeScript object.
 * It documents the core REST API endpoints that Dockhand exposes.
 *
 * Note: This is a starting point covering the most important endpoints.
 * Additional endpoints can be added incrementally.
 */

export const openapiSpec = {
	openapi: '3.0.3',
	info: {
		title: 'Dockhand API',
		version: '1.0.17',
		description:
			'Dockhand is a Docker management platform that provides a REST API for managing containers, stacks, environments, and more. This documentation covers the core API endpoints.',
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
			}
		},
		parameters: {
			envId: {
				name: 'env',
				in: 'query' as const,
				description: 'Environment ID to scope the request to',
				required: false,
				schema: { type: 'integer' }
			}
		}
	},
	security: [{ cookieAuth: [] }],
	tags: [
		{ name: 'Health', description: 'Health check endpoints' },
		{ name: 'Auth', description: 'Authentication and session management' },
		{ name: 'Environments', description: 'Docker environment management' },
		{ name: 'Containers', description: 'Container lifecycle and management' },
		{ name: 'Stacks', description: 'Docker Compose stack management' },
		{ name: 'Hawser', description: 'Hawser remote agent token management' }
	],
	paths: {
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
								schema: {
									type: 'array',
									items: { $ref: '#/components/schemas/Container' }
								}
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
			}
		},
		'/containers/{id}/start': {
			post: {
				summary: 'Start a container',
				description: 'Start a stopped Docker container.',
				tags: ['Containers'],
				parameters: [
					{
						name: 'id',
						in: 'path',
						required: true,
						schema: { type: 'string' },
						description: 'Container ID or name'
					},
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': {
						description: 'Container started',
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
					'500': {
						description: 'Failed to start container',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
				}
			}
		},
		'/containers/{id}/stop': {
			post: {
				summary: 'Stop a container',
				description: 'Stop a running Docker container.',
				tags: ['Containers'],
				parameters: [
					{
						name: 'id',
						in: 'path',
						required: true,
						schema: { type: 'string' },
						description: 'Container ID or name'
					},
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': {
						description: 'Container stopped',
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
					'500': {
						description: 'Failed to stop container',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
				}
			}
		},
		'/containers/{id}/restart': {
			post: {
				summary: 'Restart a container',
				description: 'Restart a Docker container.',
				tags: ['Containers'],
				parameters: [
					{
						name: 'id',
						in: 'path',
						required: true,
						schema: { type: 'string' },
						description: 'Container ID or name'
					},
					{ $ref: '#/components/parameters/envId' }
				],
				responses: {
					'200': {
						description: 'Container restarted',
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
					'500': {
						description: 'Failed to restart container',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
				}
			}
		},
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
								schema: {
									type: 'array',
									items: { $ref: '#/components/schemas/Stack' }
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
			}
		},
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
					'401': {
						description: 'Unauthorized',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'403': {
						description: 'Admin access required',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
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
					'400': {
						description: 'Validation error',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'401': {
						description: 'Unauthorized',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'403': {
						description: 'Admin access required',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
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
					'200': {
						description: 'Token revoked',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Success' } }
						}
					},
					'400': {
						description: 'Token ID is required',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'401': {
						description: 'Unauthorized',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'403': {
						description: 'Admin access required',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					}
				}
			}
		}
	}
} as const;
