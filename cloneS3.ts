const { S3Client, ListBucketsCommand, CreateBucketCommand, ListObjectsV2Command, CopyObjectCommand, GetBucketLocationCommand } = require('@aws-sdk/client-s3');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const fs = require('fs');

const startBucketPrefix = 'riale-calendar-productio-serverlessdeploymentbuck-xdjim6gdzgm8'; // Prefisso per i bucket di sviluppo
const targetBucketPrefix = 'testx-stage'; // Prefisso per i bucket di produzione

// Configurazione del role ARN per gli account
const roleArnA = 'arn:aws:iam::740820033840:role/OrganizationAccountAccessRole'; // Ruolo per il backup su Account A
const roleArnB = 'arn:aws:iam::740820033840:role/OrganizationAccountAccessRole'; // Ruolo per il ripristino su Account B

// Funzione per creare un client S3 con credenziali temporanee e una regione specifica
async function createS3Client(roleArn, region) {
  console.log(`Creazione del client S3 per la regione ${region} e ruolo ${roleArn}`);
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
    expiration: new Date(data.Credentials.Expiration)
  };
  console.log(`Client S3 creato con successo per la regione ${region} con credenziali temporanee`);
  return new S3Client({ region, credentials });
}

// Funzione per ottenere i bucket con un determinato prefisso
async function getBucketsWithPrefix(s3Client, prefix) {
  console.log(`Recupero dei bucket con prefisso ${prefix}`);
  const command = new ListBucketsCommand({});
  const data = await s3Client.send(command);
  const buckets = data.Buckets?.filter(bucket => bucket.Name.startsWith(prefix)) || [];
  console.log(`Trovati ${buckets.length} bucket con prefisso ${prefix}`);
  return buckets;
}

// Funzione per ottenere la regione di un bucket
async function getBucketRegion(s3Client, bucketName) {
  console.log(`Recupero della regione per il bucket ${bucketName}`);
  const command = new GetBucketLocationCommand({ Bucket: bucketName });
  const data = await s3Client.send(command);
  const location = data.LocationConstraint;
  // Se la LocationConstraint è null o una stringa vuota, significa che il bucket è nella regione us-east-1
  const region = location || 'us-east-1';
  console.log(`La regione del bucket ${bucketName} è ${region}`);
  return region;
}

// Funzione per clonare il contenuto di un bucket
async function cloneBucketContents(sourceS3, targetS3, sourceBucket, targetBucket, report) {
  console.log(`Inizio clonazione del contenuto dal bucket ${sourceBucket} al bucket ${targetBucket}`);
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
        const copySource = encodeURIComponent(`${sourceBucket}/${object.Key}`);
        const copyCommand = new CopyObjectCommand({
          Bucket: targetBucket,
          CopySource: copySource,
          Key: object.Key
        });
        try {
          await targetS3.send(copyCommand);
          console.log(`Oggetto ${object.Key} copiato con successo da ${sourceBucket} a ${targetBucket}`);
        } catch (error) {
          console.error(`Errore durante la copia dell'oggetto ${object.Key} dal bucket ${sourceBucket} al bucket ${targetBucket}: ${error.message}`);
          report.errors.push({
            bucket: sourceBucket,
            object: object.Key,
            error: error.message
          });

          // Verifica se l'errore è dovuto alla scadenza del token
          if (error.message.includes('The provided token has expired')) {
            console.log('Token scaduto, rinnovo delle credenziali temporanee...');
            // Rinnovo delle credenziali temporanee
            const newSourceS3 = await createS3Client(roleArnA, (await getBucketRegion(sourceS3, sourceBucket)));
            const newTargetS3 = await createS3Client(roleArnB, (await getBucketRegion(targetS3, targetBucket)));
            // Riprova la copia con le nuove credenziali
            try {
              await newTargetS3.send(copyCommand);
              console.log(`Oggetto ${object.Key} copiato con successo da ${sourceBucket} a ${targetBucket} con nuove credenziali`);
              continue;
            } catch (retryError) {
              console.error(`Errore durante la copia dell'oggetto ${object.Key} dal bucket ${sourceBucket} al bucket ${targetBucket} con nuove credenziali: ${retryError.message}`);
              report.errors.push({
                bucket: sourceBucket,
                object: object.Key,
                error: retryError.message
              });
            }
          }
        }
      }
    }

    // Aggiorna il continuation token per la paginazione
    continuationToken = listObjectsResponse.NextContinuationToken;
  } while (continuationToken);
  console.log(`Clonazione del contenuto dal bucket ${sourceBucket} al bucket ${targetBucket} completata`);
}

// Funzione principale
async function main() {
  const report = {
    success: [],
    errors: []
  };

  try {
    console.log('Inizio processo di clonazione dei bucket');
    // Crea client S3 per Account A e B
    const sourceS3 = await createS3Client(roleArnA, 'us-east-1'); // Usa una regione qualsiasi inizialmente
    const targetS3 = await createS3Client(roleArnB, 'us-east-1'); // Usa una regione qualsiasi inizialmente

    // Ottieni tutti i bucket di sviluppo con il prefisso specificato
    const sourceBuckets = await getBucketsWithPrefix(sourceS3, startBucketPrefix);

    // Per ogni bucket di sviluppo, clona il contenuto nel corrispondente bucket di produzione
    for (const sourceBucket of sourceBuckets) {
      const sourceBucketName = sourceBucket.Name;
      const targetBucketName = sourceBucketName.replace(startBucketPrefix, targetBucketPrefix);

      // Ottieni le regioni dei bucket di origine e di destinazione
      console.log(`Recupero della regione per il bucket di origine ${sourceBucketName}`);
      const sourceBucketRegion = await getBucketRegion(sourceS3, sourceBucketName);
      console.log(`Recupero della regione per il bucket di destinazione ${targetBucketName}`);
      const targetBucketRegion = sourceBucketRegion; // Usa la stessa regione del bucket di origine per il bucket di destinazione

      // Crea client S3 specifici per le regioni dei bucket
      console.log(`Creazione del client S3 per il bucket di origine ${sourceBucketName} nella regione ${sourceBucketRegion}`);
      const sourceS3Client = await createS3Client(roleArnA, sourceBucketRegion);
      console.log(`Creazione del client S3 per il bucket di destinazione ${targetBucketName} nella regione ${targetBucketRegion}`);
      const targetS3Client = await createS3Client(roleArnB, targetBucketRegion);

      // Crea il bucket di produzione se non esiste
      try {
        console.log(`Creazione del bucket di destinazione ${targetBucketName} nella regione ${targetBucketRegion}`);
        const createBucketCommand = new CreateBucketCommand({
          Bucket: targetBucketName,
          CreateBucketConfiguration: targetBucketRegion !== 'us-east-1' ? { LocationConstraint: targetBucketRegion } : undefined
        });
        await targetS3Client.send(createBucketCommand);
        console.log(`Bucket ${targetBucketName} creato con successo nella regione ${targetBucketRegion}`);
      } catch (error) {
        // Ignora l'errore se il bucket esiste già
        if (error.name === 'BucketAlreadyOwnedByYou') {
          console.log(`Il bucket ${targetBucketName} esiste già nella regione ${targetBucketRegion}`);
        } else {
          console.error(`Errore durante la creazione del bucket ${targetBucketName} nella regione ${targetBucketRegion}: ${error.message}`);
          report.errors.push({
            bucket: targetBucketName,
            error: error.message
          });
          continue; // Salta alla prossima iterazione del ciclo
        }
      }

      // Clona il contenuto del bucket di sviluppo nel bucket di produzione
      await cloneBucketContents(sourceS3Client, targetS3Client, sourceBucketName, targetBucketName, report);
      report.success.push({
        sourceBucket: sourceBucketName,
        targetBucket: targetBucketName
      });
    }

    console.log('Clonazione di tutti i bucket completata con successo!');
  } catch (error) {
    console.error('Errore durante la clonazione:', error.message);
  } finally {
    console.log('Report finale:');
    console.log('Bucket clonati con successo:', report.success);
    console.log('Errori durante la clonazione:', report.errors);

    // Scrivi il report su un file
    const reportContent = [
      'Report finale:',
      'Bucket clonati con successo:',
      JSON.stringify(report.success, null, 2),
      'Errori durante la clonazione:',
      JSON.stringify(report.errors, null, 2)
    ].join('\n\n');

    fs.writeFileSync('reportS3.txt', reportContent);
    console.log('Il report è stato scritto su reportS3.txt');
  }
}

main();
