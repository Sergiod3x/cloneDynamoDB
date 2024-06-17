const { S3Client, ListBucketsCommand, CreateBucketCommand, ListObjectsV2Command, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const { fromTemporaryCredentials } = require('@aws-sdk/credential-providers');

const region = 'eu-west-1'; // Regione per entrambi gli account
const startBucketPrefix = 'dev-prova-'; // Prefisso per i bucket di sviluppo
const targetBucketPrefix = 'stage-prova-'; // Prefisso per i bucket di produzione

const roleArnA = 'arn:aws:iam::475192682913:role/OrganizationAccountAccessRole'; // Ruolo per l'accesso all'Account A
const roleArnB = 'arn:aws:iam::475192682913:role/OrganizationAccountAccessRole'; // Ruolo per l'accesso all'Account B

// Funzione per creare un client S3 con credenziali temporanee
async function createS3Client(roleArn) {
  const stsClient = new STSClient({ region });
  const assumeRoleCommand = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'S3CloneSession',
  });
  const data = await stsClient.send(assumeRoleCommand);
  const credentials = {
    accessKeyId: data.Credentials.AccessKeyId,
    secretAccessKey: data.Credentials.SecretAccessKey,
    sessionToken: data.Credentials.SessionToken,
  };

  return new S3Client({ region, credentials });
}

// Funzione per ottenere i bucket con un determinato prefisso
async function getBucketsWithPrefix(s3Client, prefix) {
  const command = new ListBucketsCommand({});
  const data = await s3Client.send(command);
  return data.Buckets?.filter(bucket => bucket.Name.startsWith(prefix)) || [];
}

// Funzione per clonare il contenuto di un bucket
async function cloneBucketContents(sourceS3, targetS3, sourceBucket, targetBucket) {
  let continuationToken = null;
  do {
    // Elenca gli oggetti nel bucket di origine con paginazione
    const listObjectsParams = {
      Bucket: sourceBucket,
      ContinuationToken: continuationToken
    };
    const listObjectsCommand = new ListObjectsV2Command(listObjectsParams);
    const listObjectsResponse = await sourceS3.send(listObjectsCommand);
    const objects = listObjectsResponse.Contents;

    // Copia ogni oggetto dal bucket di origine a quello di destinazione
    if (objects) {
      for (const object of objects) {
        const copySource = `${sourceBucket}/${object.Key}`;
        const copyCommand = new CopyObjectCommand({
          Bucket: targetBucket,
          CopySource: copySource,
          Key: object.Key
        });
        await targetS3.send(copyCommand);
        console.log(`Oggetto ${object.Key} copiato con successo da ${sourceBucket} a ${targetBucket}.`);
      }
    }

    // Aggiorna il continuation token per la paginazione
    continuationToken = listObjectsResponse.NextContinuationToken;
  } while (continuationToken);
}

// Funzione principale
async function main() {
  try {
    // Crea client S3 per Account A e B
    const sourceS3 = await createS3Client(roleArnA);
    const targetS3 = await createS3Client(roleArnB);

    // Ottieni tutti i bucket di sviluppo con il prefisso specificato
    const sourceBuckets = await getBucketsWithPrefix(sourceS3, startBucketPrefix);

    // Per ogni bucket di sviluppo, clona il contenuto nel corrispondente bucket di produzione
    for (const sourceBucket of sourceBuckets) {
      const sourceBucketName = sourceBucket.Name;
      const targetBucketName = sourceBucketName.replace(startBucketPrefix, targetBucketPrefix);

      // Crea il bucket di produzione se non esiste
      try {
        const createBucketCommand = new CreateBucketCommand({ Bucket: targetBucketName });
        await targetS3.send(createBucketCommand);
        console.log(`Bucket ${targetBucketName} creato con successo.`);
      } catch (error) {
        // Ignora l'errore se il bucket esiste già
        if (error.name !== 'BucketAlreadyOwnedByYou') {
          throw error;
        }
      }

      // Clona il contenuto del bucket di sviluppo nel bucket di produzione
      await cloneBucketContents(sourceS3, targetS3, sourceBucketName, targetBucketName);
    }

    console.log('Clonazione di tutti i bucket completata con successo!');
  } catch (error) {
    console.error('Errore durante la clonazione:', error.message);
  }
}

main();
