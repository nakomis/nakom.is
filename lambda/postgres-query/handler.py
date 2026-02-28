import json
import os
import psycopg2
import logging
from typing import Dict, Any, List

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Lambda function to execute PostgreSQL queries.

    Expected event format:
    {
        "sql": "SELECT * FROM table_name LIMIT 10;"
    }
    """

    logger.info(f"Received event: {json.dumps(event, default=str)}")

    try:
        # Get SQL query from event
        sql_query = event.get('sql', '').strip()

        if not sql_query:
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'error': 'SQL query is required',
                    'example': {'sql': 'SELECT version();'}
                })
            }

        # Get database connection parameters from environment variables
        db_config = {
            'host': os.environ['DB_HOST'],
            'port': int(os.environ['DB_PORT']),
            'database': os.environ['DB_NAME'],
            'user': os.environ['DB_USER'],
            'password': os.environ['DB_PASSWORD'],
        }

        logger.info(f"Connecting to database at {db_config['host']}:{db_config['port']}")

        logger.info(f"Connecting to database at {db_config['host']}:{db_config['port']}")

        # Connect to PostgreSQL with SSL
        db_config['sslmode'] = 'require'
        connection = psycopg2.connect(**db_config)
        connection.set_session(autocommit=True)  # Enable autocommit for safety

        # Execute query
        with connection.cursor() as cursor:
            logger.info(f"Executing SQL: {sql_query[:200]}..." if len(sql_query) > 200 else f"Executing SQL: {sql_query}")

            cursor.execute(sql_query)

            # Check if query returns results
            if cursor.description:
                # SELECT-like query with results
                columns = [desc[0] for desc in cursor.description]
                rows = cursor.fetchall()

                # Convert rows to list of dictionaries
                results = []
                for row in rows:
                    row_dict = {}
                    for i, value in enumerate(row):
                        # Handle different data types
                        if hasattr(value, 'isoformat'):  # datetime objects
                            row_dict[columns[i]] = value.isoformat()
                        else:
                            row_dict[columns[i]] = value
                    results.append(row_dict)

                response = {
                    'statusCode': 200,
                    'body': json.dumps({
                        'success': True,
                        'query': sql_query,
                        'columns': columns,
                        'rows': results,
                        'row_count': len(results)
                    }, default=str)
                }

            else:
                # DML query (INSERT, UPDATE, DELETE, etc.)
                row_count = cursor.rowcount
                response = {
                    'statusCode': 200,
                    'body': json.dumps({
                        'success': True,
                        'query': sql_query,
                        'rows_affected': row_count,
                        'message': f"Query executed successfully. {row_count} rows affected."
                    })
                }

        connection.close()
        logger.info("Query executed successfully")
        return response

    except psycopg2.Error as e:
        logger.error(f"Database error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': 'Database error',
                'details': str(e),
                'query': sql_query
            })
        }

    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': 'Internal server error',
                'details': str(e),
                'query': sql_query if 'sql_query' in locals() else None
            })
        }