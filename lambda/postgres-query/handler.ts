import { Client } from 'pg';

interface QueryEvent {
  sql: string;
  database?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
}

export const handler = async (event: QueryEvent): Promise<{
  statusCode: number;
  body: string;
}> => {
  console.log('PostgreSQL Query Lambda invoked with:', JSON.stringify(event, null, 2));

  if (!event.sql) {
    console.error('No SQL query provided');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'sql parameter is required' })
    };
  }

  // Default connection parameters (override via event)
  const client = new Client({
    host: event.host || process.env.POSTGRES_HOST || 'localhost',
    port: event.port || parseInt(process.env.POSTGRES_PORT || '5432'),
    database: event.database || process.env.POSTGRES_DATABASE || 'postgres',
    user: event.username || process.env.POSTGRES_USER || 'postgres',
    password: event.password || process.env.POSTGRES_PASSWORD || '',
    ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log(`Connecting to PostgreSQL at ${client.host}:${client.port}/${client.database}`);
    await client.connect();
    console.log('Connected successfully');

    console.log('Executing SQL:', event.sql);
    const result = await client.query(event.sql);
    console.log(`Query executed successfully, returned ${result.rowCount} rows`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        rowCount: result.rowCount,
        rows: result.rows,
        fields: result.fields?.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
        command: result.command,
      }, null, 2)
    };

  } catch (error) {
    console.error('Database error:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown database error',
        detail: error instanceof Error ? error.stack : undefined
      }, null, 2)
    };

  } finally {
    try {
      await client.end();
      console.log('Database connection closed');
    } catch (closeError) {
      console.error('Error closing connection:', closeError);
    }
  }
};