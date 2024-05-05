import boto3

def lambda_handler(event, context):
    if 'pathParameters' not in event.keys():
        return google()

    pp = event["pathParameters"]
    
    if (('shortPath' not in pp.keys()) or ("" == pp["shortPath"])):
        return google()
        
    path = pp["shortPath"]
    
    if path.startswith("cat") and len(path) > 3:
        return cat(path)

    client = boto3.client('dynamodb')
    dbdata = client.get_item(TableName='redirects', Key={'shortPath': {'S': path}})
    
    if 'Item' in dbdata.keys():
        url = dbdata["Item"]["url"]["S"]
        hitcount = int(dbdata["Item"]["hitCount"]["N"])
        hitcount = hitcount + 1
        client.put_item(TableName='redirects', Item={'shortPath': {'S': path}, 'hitCount': {'N': str(hitcount)}, 'url': {'S': url}})
        if not url.startswith('http'):
            url = "https://" + url
        print("Redirecting: " + path)
        return  {
                    'statusCode': 301,
                    'headers': {
                        "Location": url
                    }
                }
                
    return bailout(path)

def bailout(path):
    print("Bailing out: " + path)
    return {
                'statusCode': 301,
                'headers': {
                    "Location": 'https://www.google.co.uk/search?q=' + path
                }
            }

def google():
    print("Defaulting to Google:")
    return {
                'statusCode': 301,
                'headers': {
                    "Location": 'https://www.google.co.uk'
                }
            }

def cat(path):
    catPath = path[3:]
    print("Redirecting to cat: " + catPath)
    
    return {
                'statusCode': 301,
                'headers': {
                    "Location": 'https://http.cat/status/' + catPath
                }
            }
